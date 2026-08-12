// Placeholder expansion, shared by everything that takes a template a user typed: a start
// command, a device name, a login email, an address to open, and the text a page step types
// into a field. Kept in a module of its own so the browser side can reach it without pulling
// in a Telegram client.

import { fillDataRefs } from "../db/dataStore";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const ALNUM = LOWER + UPPER + DIGITS;

/** Longest run of random characters a placeholder may ask for. */
const MAX_RANDOM_LEN = 4096;

function pick(chars: string, len: number): string {
  return Array.from(
    { length: len },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

// Ordinary given names and surnames, for the forms that ask for one. A random string of
// letters is fine for a username nobody reads, but a signup form that wants a name is often
// checked -- by the site, or by whoever reads the account list later.
const FIRST_NAMES = [
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph",
  "Thomas", "Charles", "Daniel", "Matthew", "Anthony", "Mark", "Paul", "Steven",
  "Andrew", "Joshua", "Kevin", "Brian", "George", "Edward", "Ryan", "Jacob",
  "Nathan", "Adam", "Peter", "Simon", "Oliver", "Henry", "Leo", "Lucas", "Ethan",
  "Noah", "Liam", "Owen", "Felix", "Victor", "Marcus", "Julian",
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan",
  "Jessica", "Sarah", "Karen", "Nancy", "Laura", "Emily", "Emma", "Olivia",
  "Sophia", "Grace", "Chloe", "Hannah", "Ava", "Mia", "Isla", "Ruby", "Alice",
  "Clara", "Nina", "Elena", "Maya", "Zoe", "Iris",
];
const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis",
  "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Martin", "Jackson", "Lee",
  "Perez", "Thompson", "White", "Harris", "Clark", "Lewis", "Walker", "Hall",
  "Allen", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams",
  "Nelson", "Carter", "Mitchell", "Turner", "Phillips", "Campbell", "Parker",
  "Evans", "Edwards", "Collins", "Stewart", "Morris", "Murphy", "Cook", "Bailey",
  "Bell", "Ward", "Cox", "Richardson", "Wood", "Watson", "Brooks", "Gray",
];

function randomOf(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/** Bounds of a `{num:1-30}`, and the width to pad the result to (0 for none). */
type NumRange = { low: number; high: number; width: number };

/**
 * Reads the bounds out of `1-30`, or nothing when the argument is a plain length.
 *
 * A leading zero is what asks for a fixed width: `{num:01-30}` gives `07`, `{num:1-30}` gives
 * `7`. Writing the low bound the way the output should look needs no second parameter, and a
 * lone `0` (`{num:0-30}`) is a bound rather than a padding request. Bounds either way round
 * mean the same range.
 */
function parseNumRange(arg: string): NumRange | undefined {
  const m = /^(\d+)-(\d+)$/.exec(arg);
  if (!m) return undefined;
  const low = Number(m[1]);
  const high = Number(m[2]);
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) return undefined;
  const padded = /^0\d/.test(m[1]) || /^0\d/.test(m[2]);
  return {
    low: Math.min(low, high),
    high: Math.max(low, high),
    width: padded ? Math.max(m[1].length, m[2].length) : 0,
  };
}

function randomInRange(r: NumRange): string {
  const n = r.low + Math.floor(Math.random() * (r.high - r.low + 1));
  return String(n).padStart(r.width, "0");
}

/**
 * Expands template placeholders before a value is used.
 * Syntax: {type}, {type:length}, or {num:low-high}
 * Types: word (lowercase), WORD (uppercase), num (digits), alpha (mixed alnum), uuid,
 * randomFirstName, randomLastName (an ordinary given name / surname; no length to give)
 *
 * `num` also takes a range: `{num:1-30}` is a number from 1 to 30, and `{num:01-30}` the same
 * range padded to two digits. A range given to any other type is left alone rather than read
 * as a length, so a template that means something else is visible instead of quietly wrong.
 *
 * An optional context map supplies named tokens (e.g. {name}) that take
 * precedence over the built-in random types.
 *
 * `{data.folder.key}` reads the data store, `{data.folder.key.field}` one field of a record,
 * and `{data.folder[me@example.com].field}` the same where the key holds a dot. Those are
 * resolved last, after the names and random tokens, so a reference may be built out of them
 * (`{data.example[{username}@example.com].password}`) -- and so a stored value that happens to
 * contain braces is used as it stands rather than expanded again.
 */
export function expandCommand(template: string, context?: Record<string, string>): string {
  const expanded = template.replace(/\{(\w+)(?::(\d+(?:-\d+)?))?\}/g, (match, type: string, arg?: string) => {
    if (context && Object.prototype.hasOwnProperty.call(context, type)) {
      return context[type];
    }
    const hasRange = !!arg && arg.includes("-");
    const range = hasRange ? parseNumRange(arg!) : undefined;
    // A range means nothing to the other types, and bounds past a safe integer are no range
    // at all: either way the placeholder is left as it stands rather than read as a length
    if (hasRange && (!range || type !== "num")) return match;
    // A length is capped: a slip of the keyboard should not ask for a gigabyte of digits
    const len = arg && !hasRange ? Math.min(parseInt(arg, 10), MAX_RANDOM_LEN) : 0;
    switch (type) {
      case "word":
        return pick(LOWER, len || 6);
      case "WORD":
        return pick(UPPER, len || 6);
      case "num":
        return range ? randomInRange(range) : pick(DIGITS, len || 6);
      case "alpha":
        return pick(ALNUM, len || 8);
      case "randomFirstName":
        return randomOf(FIRST_NAMES);
      case "randomLastName":
        return randomOf(LAST_NAMES);
      case "uuid": {
        // RFC 4122 v4
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
      }
      default:
        return match; // unknown placeholder -- leave as-is
    }
  });
  return fillDataRefs(expanded);
}

/**
 * The wordings a matcher will accept, split on `|`: `Join giveaway|参与抽奖|加入抽奖` takes
 * whichever of them is actually there. The same control is worded differently depending on
 * the language the app or bot decides to render in, and one field should cover the lot
 * rather than the operator keeping a template per language. `|` already means "any of
 * these" for the success/fail matchers, so it reads the same way everywhere.
 */
export function parseLabelAlternatives(wanted: string): string[] {
  return wanted
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Does `text` carry any of the wordings in a `|`-separated matcher? Blank matches anything. */
export function matchesAnyLabel(text: string, wanted?: string): boolean {
  const alternatives = parseLabelAlternatives(wanted ?? "");
  return !alternatives.length || alternatives.some((a) => text.includes(a));
}
