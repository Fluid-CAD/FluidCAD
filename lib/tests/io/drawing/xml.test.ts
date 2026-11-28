import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { XmlParser } from "../../../io/drawing/xml.js";
import type { XmlElement } from "../../../io/drawing/xml.js";

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

/** The tree as nested `[name, namespace, attributes, children, text]`, from this parser. */
function shape(element: XmlElement): unknown {
  return [
    element.local,
    element.namespace,
    element.attributes.map((a) => [a.local, a.namespace, a.value]).sort(),
    element.children.map(shape),
    element.text,
  ];
}

/** The same from a strict XML parser (jsdom's): what the format says the tree is. */
function strictShape(text: string): unknown {
  const walk = (element: any): unknown => [
    element.localName,
    element.namespaceURI ?? "",
    (Array.from(element.attributes) as any[])
      .filter((a) => a.name !== "xmlns" && !a.name.startsWith("xmlns:"))
      .map((a) => [a.localName, a.namespaceURI ?? "", a.value])
      .sort(),
    (Array.from(element.children) as any[]).map(walk),
    (Array.from(element.childNodes) as any[]).filter((n) => n.nodeType === 3 || n.nodeType === 4).map((n) => n.nodeValue).join(""),
  ];
  return walk(new JSDOM(text, { contentType: "application/xml" }).window.document.documentElement);
}

describe("XmlParser: the tree a strict parser reads", () => {
  const documents: Record<string, string> = {
    "elements, both quotes, self-closing tags": `<svg xmlns="${SVG}"><g id='a' class="b c"><path d="M0 0"/><rect   width = "1"
      height='2' /></g></svg>`,
    "prefixes, a default namespace that changes, attributes in namespaces": `<s:svg xmlns:s="${SVG}" xmlns:xlink="${XLINK}">
      <s:use xlink:href="#a" x="1"/><foreign xmlns="urn:other"><inner a="1"/></foreign><s:g><plain/></s:g></s:svg>`,
    "text, CDATA and references": `<svg xmlns="${SVG}"><style>a &gt; b { fill: red }<![CDATA[ c < d & e ]]> tail</style>
      <title>&lt;&amp;&quot;&apos;&#65;&#x42;&#x1F600;</title><g label="x &amp; y&#10;z"/></svg>`,
    "comments, processing instructions and a declaration": `<?xml version="1.0" encoding="UTF-8"?>
      <!-- Generator: something --><?xml-stylesheet href="a.css"?><svg xmlns="${SVG}"><!-- <g> not an element --><g/><?pi?></svg><!-- after -->`,
    "white space in values and around names": `<svg xmlns="${SVG}" viewBox="0 0\n\t10 10" ><path\n d="M0,0\nL1,1"\n/></svg >`,
  };
  for (const [name, text] of Object.entries(documents)) {
    it(name, () => {
      expect(shape(XmlParser.parse(text).root)).toEqual(strictShape(text));
    });
  }
});

describe("XmlParser: what files do", () => {
  it("expands the entities a file declares for itself, in attributes, namespaces and text", () => {
    const text = `<?xml version="1.0"?>
      <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
        <!ENTITY ns_svg "${SVG}">
        <!ENTITY ns_xlink '${XLINK}'>
        <!ENTITY st0 "fill:none;stroke:#000;">
        <!ENTITY both "&st0;opacity:1;">
      ]>
      <svg xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;"><path style="&both;" xlink:href="#a"/><desc>&st0;</desc></svg>`;
    const root = XmlParser.parse(text).root;
    expect(root.namespace).toBe(SVG);
    expect(root.children[0].attributes).toEqual([
      { name: "style", namespace: "", local: "style", value: "fill:none;stroke:#000;opacity:1;" },
      { name: "xlink:href", namespace: XLINK, local: "href", value: "#a" },
    ]);
    expect(root.children[1].text).toBe("fill:none;stroke:#000;");
  });

  it("never follows an external entity, and keeps an undefined one as written", () => {
    const text = `<!DOCTYPE svg [ <!ENTITY secret SYSTEM "file:///etc/passwd"> <!ENTITY % param "x"> ]>
      <svg><desc>&secret;|&nbsp;|&amp;</desc></svg>`;
    expect(XmlParser.parse(text).root.children[0].text).toBe("&secret;|&nbsp;|&");
  });

  it("stops entities that expand without end", () => {
    const levels = Array.from({ length: 12 }, (_, i) =>
      `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`).join("");
    const bomb = `<!DOCTYPE svg [ <!ENTITY l0 "aaaaaaaaaa">${levels} ]><svg><desc>&l12;</desc></svg>`;
    expect(() => XmlParser.parse(bomb)).toThrow(/expand without end/);
    const loop = `<!DOCTYPE svg [ <!ENTITY a "&b;"> <!ENTITY b "&a;"> ]><svg a="&a;"/>`;
    expect(() => XmlParser.parse(loop)).toThrow(/without end/);
  });

  it("keeps the comments before the root, where a program names itself", () => {
    const document = XmlParser.parse(`<?xml version="1.0"?>\n<!-- Generator: Adobe Illustrator 16.0.0 -->\n<svg><!-- inside --></svg>`);
    expect(document.comments).toEqual(["Generator: Adobe Illustrator 16.0.0"]);
  });

  it("reads past a byte-order mark and ignores what follows the root", () => {
    const document = XmlParser.parse("﻿<svg><g/></svg>\n<!-- trailing -->\n<svg again='1'/>");
    expect(document.root.children).toHaveLength(1);
    expect(document.root.attributes).toEqual([]);
  });

  it("lets through a prefix that is never declared, an attribute without quotes and one without a value", () => {
    const root = XmlParser.parse(`<svg><use xlink:href="#a" inkscape:label="L" odd:thing="1" width=10 hidden/></svg>`).root;
    const use = root.children[0];
    expect(use.attributes.map((a) => [a.name, a.namespace, a.value])).toEqual([
      ["xlink:href", XLINK, "#a"],
      ["inkscape:label", "http://www.inkscape.org/namespaces/inkscape", "L"],
      ["odd:thing", "", "1"],
      ["width", "", "10"],
      ["hidden", "", ""],
    ]);
    expect(root.namespace).toBe("");
  });

  it("refuses a file whose structure is broken, saying where", () => {
    expect(() => XmlParser.parse("<svg>\n<g>\n</svg>")).toThrow(/<\/svg> closes <g> \(line 3\)/);
    expect(() => XmlParser.parse("<svg><g></g>")).toThrow(/ends inside <svg>/);
    expect(() => XmlParser.parse("<svg><path d='M0 0></svg>")).toThrow(/attribute d of <path> is never closed/);
    expect(() => XmlParser.parse("<svg><!-- open</svg>")).toThrow(/comment is never closed/);
    expect(() => XmlParser.parse("0\nSECTION\n2\nENTITIES\n")).toThrow(/does not start with an XML element/);
    expect(() => XmlParser.parse("")).toThrow(/has no elements/);
    expect(() => XmlParser.parse("<a>".repeat(1500))).toThrow(/nested more than 1000 deep/);
  });
});
