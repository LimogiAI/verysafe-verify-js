import { describe, expect, it } from "vitest";
import { detect } from "../src/browser/detect.js";

const PHONE = "Mozilla/5.0 (Linux; Android 16; SM-X210) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
const LAPTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

function browser(options: { api?: boolean; allows?: (p: string) => boolean; userAgent: string; mobileHint?: boolean }) {
  const navigator: Record<string, unknown> = { userAgent: options.userAgent };
  if (options.mobileHint !== undefined) navigator.userAgentData = { mobile: options.mobileHint };
  if (options.api) navigator.credentials = { get: async () => null };
  const g: Record<string, unknown> = { navigator };
  if (options.api) g.DigitalCredential = options.allows === undefined ? {} : { userAgentAllowsProtocol: options.allows };
  return g;
}

describe("detect", () => {
  it("chooses the browser prompt where the API allows our protocol", () => {
    const d = detect({ globalObject: browser({ api: true, allows: (p) => p === "openid4vp-v1-signed", userAgent: PHONE }) });
    expect(d).toEqual({ digitalCredentials: true, protocols: ["openid4vp-v1-signed"], phone: true, flow: "dc_api" });
  });

  it("falls back to a link on a phone whose browser allows only the ISO mdoc protocol, as Safari does", () => {
    const d = detect({ globalObject: browser({ api: true, allows: (p) => p === "org-iso-mdoc", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/605.1.15" }) });
    expect(d.digitalCredentials).toBe(true);
    expect(d.protocols).toEqual([]);
    expect(d.flow).toBe("same_device");
  });

  it("falls back to a QR code on a computer with no API", () => {
    expect(detect({ globalObject: browser({ userAgent: LAPTOP }) }).flow).toBe("cross_device");
  });

  it("falls back to a link on a phone with no API", () => {
    expect(detect({ globalObject: browser({ userAgent: PHONE }) }).flow).toBe("same_device");
  });

  it("takes a browser with the API but without the protocol check to allow every protocol asked about", () => {
    const d = detect({ globalObject: browser({ api: true, userAgent: LAPTOP }), protocols: ["openid4vp-v1-signed", "org-iso-mdoc"] });
    expect(d.protocols).toEqual(["openid4vp-v1-signed", "org-iso-mdoc"]);
    expect(d.flow).toBe("dc_api");
  });

  it("treats a check that throws as a refusal", () => {
    const d = detect({
      globalObject: browser({
        api: true,
        allows: () => {
          throw new Error("no");
        },
        userAgent: LAPTOP,
      }),
    });
    expect(d.flow).toBe("cross_device");
  });

  it("believes the client hint over the user agent string", () => {
    expect(detect({ globalObject: browser({ userAgent: LAPTOP, mobileHint: true }) }).phone).toBe(true);
  });
});
