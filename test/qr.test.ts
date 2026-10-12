// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { qrPath, qrSvg } from "../src/browser/qr.js";

const LINK = "openid4vp://?client_id=x509_hash%3Aabc&request_uri=https%3A%2F%2Fverify.verysafe.id%2Fv1%2Fverifications%2F0f0a7d4a-1c2b-4e3f-9a8b-7c6d5e4f3a2b%2Frequest.jwt";

describe("qrPath", () => {
  it("draws a code whose top-left finder pattern is seven dark modules wide", () => {
    const { size, d } = qrPath(LINK);
    expect(size).toBeGreaterThanOrEqual(21);
    expect(d.startsWith("M0 0h7v1h-7z")).toBe(true);
  });
});

describe("qrSvg", () => {
  it("builds an SVG from attributes only: no style attribute, no script, no data URL", () => {
    const svg = qrSvg(LINK, { title: "Scan" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.querySelector("title")?.textContent).toBe("Scan");
    expect(svg.querySelector("path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    const html = svg.outerHTML;
    expect(html).not.toMatch(/style=|<script|data:/);
  });
});
