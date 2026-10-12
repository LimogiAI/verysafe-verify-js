import qrcode from "qrcode-generator";

/** The modules of a QR code for `text`, as one SVG path in a `size`×`size` grid. Pure; no DOM. */
export function qrPath(text: string): { size: number; d: string } {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const size = code.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!code.isDark(row, col)) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < size && code.isDark(row, col + run)) run++;
      parts.push(`M${col} ${row}h${run}v1h-${run}z`);
      col += run;
    }
  }
  return { size, d: parts.join("") };
}

export interface QrSvgOptions {
  /** Quiet zone in modules around the code; 4 by default, as the standard asks. */
  margin?: number;
  /** An accessible title for the image. */
  title?: string;
  /** The document to create elements in; the page's by default. */
  document?: Document;
}

/**
 * A QR code of `text` as an SVG element, drawn from attributes only, so it
 * renders under a strict Content Security Policy: no inline style, no
 * script, no data: URL. Size it with CSS on the element.
 */
export function qrSvg(text: string, options: QrSvgOptions = {}): SVGSVGElement {
  const doc = options.document ?? document;
  const margin = options.margin ?? 4;
  const { size, d } = qrPath(text);
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  const total = size + margin * 2;
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("shape-rendering", "crispEdges");
  if (options.title !== undefined) {
    const title = doc.createElementNS(ns, "title");
    title.textContent = options.title;
    svg.appendChild(title);
  }
  const background = doc.createElementNS(ns, "rect");
  background.setAttribute("width", String(total));
  background.setAttribute("height", String(total));
  background.setAttribute("fill", "#ffffff");
  svg.appendChild(background);
  const path = doc.createElementNS(ns, "path");
  path.setAttribute("transform", `translate(${margin} ${margin})`);
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.appendChild(path);
  return svg;
}
