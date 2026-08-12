// The data store, against the real schema: what a job reads with `{data.folder.key}`, what
// the save and delete steps do to a stored value, and the folder/record CRUD the Data view
// drives. The path arithmetic is the part worth pinning down -- writing one field of a record
// must leave the rest of it alone, which is the whole reason a path exists.
//
// The database is a throwaway one: under vitest db/database.ts refuses the working
// directory's own file and makes a temp one, so the fixtures below clear tables that
// belong to this run alone.

import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/database";
import {
  createFolder,
  createRecord,
  dataRefText,
  deleteDataValue,
  deleteRecord,
  exportData,
  fillDataRefs,
  findFolderByName,
  getRecord,
  isValidDataName,
  listFolders,
  listRecords,
  parseDataValue,
  readDataRef,
  renameFolder,
  updateRecord,
  writeDataValue,
} from "../db/dataStore";

// The deployment-level gate. Unlike DB_PATH this is read when the check runs, not when the
// module is imported, so setting it here is early enough.
process.env.DATA_MANAGEMENT = "1";

function setEnabled(on: boolean): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('data_store_enabled', ?)").run(
    String(on),
  );
}

beforeEach(() => {
  db.prepare("DELETE FROM data_records").run();
  db.prepare("DELETE FROM data_folders").run();
  setEnabled(true);
});

/** The shape the feature was designed around: a folder with one record holding a JSON value. */
function seedExample(): number {
  const folderId = createFolder("example");
  createRecord(folderId, "email", { password: "xxxx", other: "othervalue" });
  return folderId;
}

describe("value input", () => {
  it("stores JSON as JSON and anything else as text", () => {
    expect(parseDataValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseDataValue("42")).toBe(42);
    expect(parseDataValue("true")).toBe(true);
    expect(parseDataValue("hunter2")).toBe("hunter2");
    expect(parseDataValue("")).toBe("");
  });

  it("only accepts names that can be written as a reference", () => {
    expect(isValidDataName("example")).toBe(true);
    expect(isValidDataName("my-folder_2")).toBe(true);
    // The case this feature exists for: a signup's record keyed by the address it made
    expect(isValidDataName("Ava_Hall_7592@example.com")).toBe(true);
    expect(isValidDataName("has space in it")).toBe(true);
    expect(isValidDataName("holds [a bracket]")).toBe(false);
    expect(isValidDataName("holds {a brace}")).toBe(false);
    expect(isValidDataName(" leading space")).toBe(false);
    expect(isValidDataName("trailing space ")).toBe(false);
    expect(isValidDataName("")).toBe(false);
  });

  it("writes the reference a name needs: dotted, or bracketed for a name with a dot", () => {
    expect(dataRefText("example", "email")).toBe("{data.example.email}");
    expect(dataRefText("example", "email", "password")).toBe(
      "{data.example.email.password}",
    );
    expect(dataRefText("example", "me@example.com", "password")).toBe(
      "{data.example[me@example.com].password}",
    );
  });
});

describe("reading", () => {
  it("reads a whole record and one field of it", () => {
    seedExample();
    expect(readDataRef("example.email.password")).toBe("xxxx");
    expect(JSON.parse(readDataRef("example.email")!)).toEqual({
      password: "xxxx",
      other: "othervalue",
    });
  });

  it("reads a bare value without quoting it", () => {
    const folderId = createFolder("sites");
    createRecord(folderId, "invite", "ABC-123");
    expect(readDataRef("sites.invite")).toBe("ABC-123");
  });

  it("indexes into a list", () => {
    const folderId = createFolder("sites");
    createRecord(folderId, "codes", ["one", "two"]);
    expect(readDataRef("sites.codes.1")).toBe("two");
  });

  it("reads a key holding a dot through the bracket form", () => {
    const folderId = createFolder("example");
    createRecord(folderId, "Ava_Hall_7592@example.com", { password: "xxxx" });
    expect(readDataRef("example[Ava_Hall_7592@example.com].password")).toBe("xxxx");
    expect(JSON.parse(readDataRef("example[Ava_Hall_7592@example.com]")!)).toEqual({
      password: "xxxx",
    });
    // The dotted form cannot reach it: the dots in the address are separators there
    expect(readDataRef("example.Ava_Hall_7592@example.com.password")).toBeNull();
  });

  it("reads a folder holding a dot, and a field name holding one", () => {
    const folderId = createFolder("my.folder");
    createRecord(folderId, "acct", { "a.b": "nested" });
    expect(readDataRef("[my.folder].acct[a.b]")).toBe("nested");
  });

  it("returns nothing for a folder, record or field that is not there", () => {
    seedExample();
    expect(readDataRef("gmail.email")).toBeNull();
    expect(readDataRef("example.missing")).toBeNull();
    expect(readDataRef("example.email.nope")).toBeNull();
    expect(readDataRef("example")).toBeNull();
  });
});

// A folder used as a queue is keyed by whatever the run made -- a username, an address -- so
// a reference has to be able to say "the one at the front" without naming it, and to read that
// name back out. Neither was reachable before: a key had to be spelled out, and a path walks
// the value, which the key is not part of.
describe("reading by position", () => {
  /** Two accounts, added in this order, keyed the way a signup queue is. */
  function seedQueue(): number {
    const folderId = createFolder("tbd_outlook");
    createRecord(folderId, "luckycee23", { password: "second" });
    createRecord(folderId, "jaclee324", { password: "first" });
    return folderId;
  }

  it("takes the record at a position, oldest first", () => {
    seedQueue();
    expect(readDataRef("tbd_outlook.#0.password")).toBe("second");
    expect(readDataRef("tbd_outlook.#1.password")).toBe("first");
  });

  it("reads the record's own key, which is what identifies it", () => {
    seedQueue();
    expect(readDataRef("tbd_outlook.#0.#key")).toBe("luckycee23");
    expect(readDataRef("tbd_outlook.#1.#key")).toBe("jaclee324");
    // And by name too, so the rule is the same however the record was named
    expect(readDataRef("tbd_outlook.jaclee324.#key")).toBe("jaclee324");
  });

  it("follows the queue as records go, rather than the key it started on", () => {
    const folderId = seedQueue();
    deleteDataValue("tbd_outlook", "#0", "");
    expect(readDataRef("tbd_outlook.#0.#key")).toBe("jaclee324");
    expect(listRecords(folderId)).toHaveLength(1);
  });

  it("reads the whole value of a positional record", () => {
    seedQueue();
    expect(JSON.parse(readDataRef("tbd_outlook.#0")!)).toEqual({ password: "second" });
  });

  it("says nothing for a position the folder does not reach", () => {
    seedQueue();
    expect(readDataRef("tbd_outlook.#7.#key")).toBeNull();
    expect(fillDataRefs("{data.tbd_outlook.#7.#key}")).toBe("{data.tbd_outlook.#7.#key}");
  });

  it("fills a position in a template, brackets or dots", () => {
    seedQueue();
    expect(fillDataRefs("un={data.tbd_outlook.#0.#key}")).toBe("un=luckycee23");
    expect(fillDataRefs("un={data.tbd_outlook[#0].#key}")).toBe("un=luckycee23");
  });

  // A number is a name like any other: a folder keyed by id must not have `0` read as
  // "whichever record is first", and a record actually named `#0` still answers to it
  it("treats a plain number as a key, not a position", () => {
    const folderId = createFolder("byId");
    createRecord(folderId, "7", { note: "seven" });
    createRecord(folderId, "0", { note: "zero" });
    expect(readDataRef("byId.0.note")).toBe("zero");
    expect(readDataRef("byId.#0.note")).toBe("seven");
  });

  it("prefers a record whose key is literally the position form", () => {
    const folderId = createFolder("odd");
    createRecord(folderId, "first", { note: "by position" });
    createRecord(folderId, "#0", { note: "by name" });
    expect(readDataRef("odd.#0.note")).toBe("by name");
  });

  it("writes to the record at a position, and refuses an empty one", () => {
    seedQueue();
    writeDataValue("tbd_outlook", "#0", "password", "changed");
    expect(readDataRef("tbd_outlook.luckycee23.password")).toBe("changed");
    expect(() => writeDataValue("tbd_outlook", "#9", "password", "x")).toThrow(
      /no record at position/,
    );
    // Nothing named `#9` was invented on the way
    expect(getRecord(findFolderByName("tbd_outlook")!.id, "#9")).toBeNull();
  });
});

describe("fillDataRefs", () => {
  it("fills a reference in the middle of a template", () => {
    seedExample();
    expect(fillDataRefs("pw={data.example.email.password}!")).toBe("pw=xxxx!");
  });

  it("leaves a reference with nothing behind it as it stands", () => {
    seedExample();
    expect(fillDataRefs("{data.example.email.nope}")).toBe("{data.example.email.nope}");
  });

  it("fills the bracket form", () => {
    const folderId = createFolder("example");
    createRecord(folderId, "me@example.com", { password: "xxxx" });
    expect(fillDataRefs("pw={data.example[me@example.com].password}")).toBe("pw=xxxx");
  });

  it("leaves other placeholders alone", () => {
    seedExample();
    expect(fillDataRefs("{word:6} {username}")).toBe("{word:6} {username}");
  });

  it("resolves nothing while the store is switched off", () => {
    seedExample();
    setEnabled(false);
    expect(fillDataRefs("{data.example.email.password}")).toBe(
      "{data.example.email.password}",
    );
  });
});

describe("writing", () => {
  it("makes the folder and the record when neither exists yet", () => {
    writeDataValue("gmail", "email", "", { password: "s3cret" });
    expect(findFolderByName("gmail")).not.toBeNull();
    expect(readDataRef("gmail.email.password")).toBe("s3cret");
  });

  it("writes one field and leaves the rest of the record alone", () => {
    seedExample();
    writeDataValue("example", "email", "password", "rotated");
    expect(readDataRef("example.email.password")).toBe("rotated");
    expect(readDataRef("example.email.other")).toBe("othervalue");
  });

  it("builds the objects a nested path needs", () => {
    writeDataValue("sites", "acct", "login.password", "pw");
    expect(readDataRef("sites.acct.login.password")).toBe("pw");
  });

  it("replaces the whole record when no path is given", () => {
    seedExample();
    writeDataValue("example", "email", "", "just text now");
    expect(readDataRef("example.email")).toBe("just text now");
  });

  it("stores under a key holding a dot, reachable through the bracket form", () => {
    writeDataValue("example", "Ava_Hall_7592@example.com", "password", "xxxx");
    expect(readDataRef("example[Ava_Hall_7592@example.com].password")).toBe("xxxx");
  });

  it("refuses a name that could not be written as a reference", () => {
    expect(() => writeDataValue("exam[ple]", "email", "", "x")).toThrow(/folder name/);
    expect(() => writeDataValue("example", "e{mail}", "", "x")).toThrow(/record key/);
  });
});

describe("deleting", () => {
  it("removes one field and keeps the record", () => {
    seedExample();
    expect(deleteDataValue("example", "email", "password")).toBe(true);
    expect(readDataRef("example.email.password")).toBeNull();
    expect(readDataRef("example.email.other")).toBe("othervalue");
  });

  it("removes the whole record when no path is given", () => {
    const folderId = seedExample();
    expect(deleteDataValue("example", "email", "")).toBe(true);
    expect(getRecord(folderId, "email")).toBeNull();
  });

  it("says so when there was nothing there", () => {
    seedExample();
    expect(deleteDataValue("example", "email", "nope")).toBe(false);
    expect(deleteDataValue("example", "missing", "")).toBe(false);
    expect(deleteDataValue("gmail", "email", "")).toBe(false);
  });
});

describe("folders and records", () => {
  it("counts a folder's records, and loses them with the folder", () => {
    const folderId = seedExample();
    createRecord(folderId, "recovery", "me@example.com");
    expect(listFolders()).toEqual([
      expect.objectContaining({ name: "example", recordCount: 2 }),
    ]);

    db.prepare("DELETE FROM data_folders WHERE id = ?").run(folderId);
    expect(listRecords(folderId)).toEqual([]);
  });

  it("keeps a record where it was when its folder is renamed", () => {
    const folderId = seedExample();
    expect(renameFolder(folderId, "example-old")).toBe(true);
    expect(readDataRef("example-old.email.password")).toBe("xxxx");
    expect(readDataRef("example.email.password")).toBeNull();
  });

  it("renames a key and rewrites a value", () => {
    const folderId = seedExample();
    const record = getRecord(folderId, "email")!;
    expect(updateRecord(record.id, { key: "login", value: { password: "new" } })).toBe(true);
    expect(readDataRef("example.login.password")).toBe("new");
    expect(deleteRecord(record.id)).toBe(true);
    expect(listRecords(folderId)).toEqual([]);
  });

  it("exports every folder, or just the one asked for", () => {
    const folderId = seedExample();
    createFolder("gmail");

    const all = exportData();
    expect(all.folders.map((f) => f.name)).toEqual(["example", "gmail"]);

    const one = exportData(folderId);
    expect(one.folders).toEqual([
      { name: "example", records: [{ key: "email", value: { password: "xxxx", other: "othervalue" } }] },
    ]);
  });
});
