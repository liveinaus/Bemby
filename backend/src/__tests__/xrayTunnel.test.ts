// What a link turns into once the core is the thing carrying it. The config is the whole
// contract with Xray, so it is checked here rather than only end to end.

import { describe, expect, it } from "vitest";
import { parseNodeLink } from "../tg/proxyNodes";
import { buildXrayConfig } from "../tg/xrayTunnel";

const UUID = "d342d11e-d424-4583-b36e-524ab1f0afa4";

const configFor = (link: string, port = 24080) =>
  buildXrayConfig([{ port, node: parseNodeLink(link)! }]);

describe("buildXrayConfig", () => {
  it("gives each node its own loopback inbound and routes it to its own outbound", () => {
    const config = buildXrayConfig([
      { port: 24080, node: parseNodeLink(`vless://${UUID}@a.com:443?type=tcp&security=tls`)! },
      { port: 24081, node: parseNodeLink(`vless://${UUID}@b.com:443?type=tcp&security=tls`)! },
    ]) as any;

    expect(config.inbounds).toHaveLength(2);
    expect(config.inbounds[0]).toMatchObject({
      tag: "in-24080",
      listen: "127.0.0.1",
      port: 24080,
      protocol: "socks",
      settings: { auth: "noauth" },
    });
    // No sniffing anywhere: a destination hostname has to reach the node unresolved
    expect(config.inbounds[0].sniffing).toBeUndefined();
    expect(config.routing.rules).toEqual([
      { type: "field", inboundTag: ["in-24080"], outboundTag: "out-24080" },
      { type: "field", inboundTag: ["in-24081"], outboundTag: "out-24081" },
    ]);
  });

  it("carries a REALITY node's keys, flow and fingerprint", () => {
    const config = configFor(
      `vless://${UUID}@node.example.com:50994?type=tcp&encryption=none&security=reality&flow=xtls-rprx-vision&fp=chrome&sni=www.python.org&pbk=2Pkx&sid=0fd8d811#HK`,
    ) as any;

    expect(config.outbounds[0]).toMatchObject({
      tag: "out-24080",
      protocol: "vless",
      settings: {
        vnext: [
          {
            address: "node.example.com",
            port: 50994,
            users: [{ id: UUID, encryption: "none", flow: "xtls-rprx-vision" }],
          },
        ],
      },
      streamSettings: {
        network: "tcp",
        security: "reality",
        realitySettings: {
          serverName: "www.python.org",
          publicKey: "2Pkx",
          shortId: "0fd8d811",
          fingerprint: "chrome",
        },
      },
    });
  });

  it("assumes a browser fingerprint for a REALITY link that states none", () => {
    const config = configFor(`vless://${UUID}@a.com:443?type=tcp&security=reality&pbk=k`) as any;
    expect(config.outbounds[0].streamSettings.realitySettings.fingerprint).toBe("chrome");
  });

  it("puts the host header where each transport keeps it", () => {
    const ws = configFor(
      `vless://${UUID}@a.com:443?type=ws&security=tls&host=cdn.example.com&path=%2Fray`,
    ) as any;
    expect(ws.outbounds[0].streamSettings).toMatchObject({
      network: "ws",
      security: "tls",
      wsSettings: { path: "/ray", headers: { Host: "cdn.example.com" } },
      tlsSettings: { serverName: "cdn.example.com" },
    });

    const grpc = configFor(`vless://${UUID}@a.com:443?type=grpc&security=tls&serviceName=gun`) as any;
    expect(grpc.outbounds[0].streamSettings.grpcSettings).toEqual({ serviceName: "gun" });
  });

  it("writes the shape each protocol's settings take", () => {
    const trojan = configFor("trojan://sekrit@t.example.com:443?sni=t.example.com") as any;
    expect(trojan.outbounds[0]).toMatchObject({
      protocol: "trojan",
      settings: { servers: [{ address: "t.example.com", port: 443, password: "sekrit" }] },
    });

    const userinfo = Buffer.from("aes-256-gcm:hunter2").toString("base64");
    const ss = configFor(`ss://${userinfo}@s.example.com:8388`) as any;
    expect(ss.outbounds[0]).toMatchObject({
      protocol: "shadowsocks",
      settings: { servers: [{ method: "aes-256-gcm", password: "hunter2" }] },
      streamSettings: { network: "tcp", security: "none" },
    });
  });
});
