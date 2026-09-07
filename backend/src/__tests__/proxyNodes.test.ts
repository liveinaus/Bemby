// Reading subscription links: the Workers deployments Bemby has always carried, and the
// commercial sellers' nodes that need the Xray core.

import { describe, expect, it } from "vitest";
import { nodeKey, nodeKind, parseNodeLink, parseSubscription } from "../tg/proxyNodes";

const UUID = "d342d11e-d424-4583-b36e-524ab1f0afa4";

describe("parseNodeLink", () => {
  it("reads the link a Workers deployment hands out", () => {
    expect(
      parseNodeLink(
        `vless://${UUID}@cf.example.com:443?encryption=none&security=tls&sni=my.worker.dev&fp=randomized&type=ws&host=my.worker.dev&path=%2F%3Fed%3D2048#Sydney`,
      ),
    ).toMatchObject({
      protocol: "vless",
      address: "cf.example.com",
      port: 443,
      id: UUID,
      transport: "ws",
      security: "tls",
      sni: "my.worker.dev",
      hostHeader: "my.worker.dev",
      path: "/?ed=2048",
      name: "Sydney",
    });
  });

  it("falls back to the host header for sni, and to port 443 with tls", () => {
    const node = parseNodeLink(`vless://${UUID}@1.2.3.4?security=tls&type=ws&host=my.worker.dev&path=%2F`);
    expect(node?.port).toBe(443);
    expect(node?.sni).toBe("my.worker.dev");
  });

  it("takes a plain ws node on port 80 with a root path", () => {
    expect(parseNodeLink(`vless://${UUID}@1.2.3.4`)).toMatchObject({
      port: 80,
      transport: "ws",
      security: "none",
      path: "/",
      sni: undefined,
    });
  });

  it("reads the VLESS-REALITY node a seller's panel serves", () => {
    const node = parseNodeLink(
      `vless://${UUID}@node.example.com:50994?type=tcp&encryption=none&host=&path=&headerType=none&security=reality&flow=xtls-rprx-vision&fp=chrome&sni=www.python.org&pbk=2Pkxdiu4QDOEBZb-gQ0zPOMoj4Gzef6swOP0jOPhHBc&sid=0fd8d811#HK%201`,
    );
    expect(node).toMatchObject({
      protocol: "vless",
      address: "node.example.com",
      port: 50994,
      transport: "tcp",
      security: "reality",
      flow: "xtls-rprx-vision",
      fingerprint: "chrome",
      sni: "www.python.org",
      publicKey: "2Pkxdiu4QDOEBZb-gQ0zPOMoj4Gzef6swOP0jOPhHBc",
      shortId: "0fd8d811",
      name: "HK 1",
    });
    // tcp carries no path, and an empty host param is not a host header
    expect(node?.path).toBeUndefined();
    expect(node?.hostHeader).toBeUndefined();
  });

  it("reads vmess, trojan and shadowsocks", () => {
    const vmess = `vmess://${Buffer.from(
      JSON.stringify({ v: "2", ps: "Tokyo", add: "1.2.3.4", port: "443", id: UUID, aid: "0", net: "ws", host: "cdn.example.com", path: "/ray", tls: "tls" }),
    ).toString("base64")}`;
    expect(parseNodeLink(vmess)).toMatchObject({
      protocol: "vmess",
      address: "1.2.3.4",
      port: 443,
      transport: "ws",
      security: "tls",
      path: "/ray",
      sni: "cdn.example.com",
      name: "Tokyo",
    });

    expect(parseNodeLink("trojan://sekrit@t.example.com:443?sni=t.example.com#Trojan")).toMatchObject({
      protocol: "trojan",
      id: "sekrit",
      transport: "tcp",
      security: "tls", // trojan is TLS whether or not the link says so
      sni: "t.example.com",
    });

    const userinfo = Buffer.from("aes-256-gcm:hunter2").toString("base64");
    expect(parseNodeLink(`ss://${userinfo}@s.example.com:8388#SS`)).toMatchObject({
      protocol: "shadowsocks",
      method: "aes-256-gcm",
      id: "hunter2",
      address: "s.example.com",
      port: 8388,
      name: "SS",
    });
  });

  it("turns down what no core here speaks", () => {
    expect(parseNodeLink("hysteria2://pass@a.com:443")).toBeUndefined();
    expect(parseNodeLink("ssr://anything")).toBeUndefined();
    expect(parseNodeLink(`vless://not-a-uuid@a.com:443?type=ws`)).toBeUndefined();
    expect(parseNodeLink(`vless://${UUID}@a.com:443?type=ws&security=xtls`)).toBeUndefined();
    expect(parseNodeLink("nonsense")).toBeUndefined();
    // A shadowsocks plugin is a separate program this does not have
    const userinfo = Buffer.from("aes-256-gcm:hunter2").toString("base64");
    expect(parseNodeLink(`ss://${userinfo}@s.example.com:8388?plugin=obfs-local#SS`)).toBeUndefined();
  });
});

describe("parseSubscription", () => {
  const links = [
    `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#One`,
    `vless://${UUID}@b.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Two`,
  ].join("\n");

  it("reads a plain body", () => {
    expect(parseSubscription(links).nodes.map((n) => n.name)).toEqual(["One", "Two"]);
  });

  it("reads a base64 body, which is what most subscriptions serve", () => {
    const { nodes } = parseSubscription(Buffer.from(links).toString("base64"));
    expect(nodes.map((n) => n.address)).toEqual(["a.example.com", "b.example.com"]);
  });

  it("collapses repeats and counts only the links no core here speaks", () => {
    const { nodes, skipped } = parseSubscription(
      [links, links, "trojan://x@c.example.com:443", "hysteria2://y@d.example.com:443"].join("\n"),
    );
    expect(nodes.map((n) => n.protocol)).toEqual(["vless", "vless", "trojan"]);
    expect(skipped).toBe(1);
  });

  it("names differ but the node is the same, so the first name stands", () => {
    const { nodes } = parseSubscription(
      [
        `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#First`,
        `vless://${UUID}@a.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Second`,
      ].join("\n"),
    );
    expect(nodes.map((n) => n.name)).toEqual(["First"]);
  });
});

describe("nodeKey", () => {
  // The ids an install already holds are derived from this, and jobs are pinned to them:
  // a WebSocket node has to hash to what it hashed to before other protocols existed here
  it("keeps the identity a VLESS-over-WebSocket node has always had", () => {
    const node = parseNodeLink(
      `vless://${UUID}@cf.example.com:443?type=ws&security=tls&host=w.dev&path=%2F#Sydney`,
    )!;
    // sha1("cf.example.com|443|<uuid>|true|w.dev|w.dev|/"), which is what the build that
    // only knew about WebSocket hashed
    expect(nodeKey(node)).toBe("22fe1828fa4e");
  });

  it("separates nodes that differ only in what carries them", () => {
    const reality = parseNodeLink(`vless://${UUID}@a.com:443?type=tcp&security=reality&pbk=k&sid=01`)!;
    const plain = parseNodeLink(`vless://${UUID}@a.com:443?type=tcp&security=tls`)!;
    expect(nodeKey(reality)).not.toBe(nodeKey(plain));
  });
});

describe("nodeKind", () => {
  it("says what a node is, for the panel's counts", () => {
    expect(nodeKind(parseNodeLink(`vless://${UUID}@a.com:443?type=tcp&security=reality&pbk=k`)!)).toBe(
      "VLESS-tcp-reality",
    );
  });
});
