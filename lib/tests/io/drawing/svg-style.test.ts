import { describe, it, expect } from "vitest";
import { SvgStyleSheet } from "../../../io/drawing/svg-style.js";
import { XmlParser } from "../../../io/drawing/xml.js";
import type { XmlElement } from "../../../io/drawing/xml.js";

/** The elements of a document by id, and what a sheet declares for each. */
function styled(css: string, body: string): (id: string) => Record<string, string> {
  const root = XmlParser.parse(`<svg xmlns="http://www.w3.org/2000/svg" id="root">${body}</svg>`).root;
  const byId = new Map<string, XmlElement>();
  const walk = (element: XmlElement) => {
    const id = element.attributes.find((a) => a.name === 'id')?.value;
    if (id) {
      byId.set(id, element);
    }
    element.children.forEach(walk);
  };
  walk(root);
  const sheet = new SvgStyleSheet([css]);
  return (id) => Object.fromEntries(sheet.declared(byId.get(id)!));
}

describe("SvgStyleSheet: which rules reach an element", () => {
  const body = `<g id="g" class="outer"><path id="a" class="x y"/><path id="b" class="y" data-kind="cut"/><rect id="c"/>
    <g id="inner"><path id="d" class="x"/></g></g><path id="e" class="x"/>`;

  it("matches by element name, class, id, attribute and the universal selector", () => {
    const of = styled(`path { fill: a } .y { stroke: b } #c { fill: c } [data-kind] { opacity: 0.5 } [data-kind="cut"] { mask: m } * { visibility: v }`, body);
    expect(of('a')).toEqual({ fill: 'a', stroke: 'b', visibility: 'v' });
    expect(of('b')).toEqual({ fill: 'a', stroke: 'b', opacity: '0.5', mask: 'm', visibility: 'v' });
    expect(of('c')).toEqual({ fill: 'c', visibility: 'v' });
  });

  it("follows descendant, child and sibling combinators", () => {
    const of = styled(`.outer path { fill: in } .outer > path { stroke: child } #a + path { opacity: next } #a ~ rect { mask: later } svg > g > g > .x { display: deep }`, body);
    expect(of('a')).toEqual({ fill: 'in', stroke: 'child' });
    expect(of('b')).toEqual({ fill: 'in', stroke: 'child', opacity: 'next' });
    expect(of('c')).toEqual({ mask: 'later' });
    expect(of('d')).toEqual({ fill: 'in', display: 'deep' });
    expect(of('e')).toEqual({});
  });

  it("reads :root, :first-child, :last-child and :not(), compound selectors and lists", () => {
    const of = styled(`:root { fill: r } path:first-child { stroke: first } g > :last-child { opacity: last } path:not(.x) { mask: n } path.x.y, rect { display: both }`, body);
    expect(of('root')).toEqual({ fill: 'r' });
    expect(of('a')).toEqual({ stroke: 'first', display: 'both' });
    expect(of('b')).toEqual({ mask: 'n' });
    expect(of('c')).toEqual({ display: 'both' });
    expect(of('inner')).toEqual({ opacity: 'last' });
    expect(of('d')).toEqual({ stroke: 'first', opacity: 'last' });
  });

  it("never matches by a selector it does not read, and passes over what is not a rule", () => {
    const of = styled(`path:hover { fill: h } path::before { fill: b } path:nth-child(2) { fill: n } a b > > c { fill: x }
      @import url(x.css); @charset "utf-8"; @font-face { fill: f } @keyframes k { from { fill: a } to { fill: b } }
      /* path { fill: comment } */ <!-- path { stroke: s } -->
      @media print { path { fill: p } } @media screen, print { path { opacity: m } } @media (min-width: 100px) { path { fill: w } }`, body);
    expect(of('a')).toEqual({ stroke: 's', opacity: 'm' });
  });
});

describe("SvgStyleSheet: which value wins", () => {
  it("puts a rule over an attribute, a style over a rule, and !important over both", () => {
    const of = styled(`.k { fill: rule; stroke: rule; opacity: 0.1 !important; display: rule !important }`,
      `<path id="p" class="k" fill="attribute" stroke="attribute" visibility="attribute" opacity="1" style="stroke: style; opacity: 0.9; display: style"/>`);
    expect(of('p')).toEqual({ fill: 'rule', stroke: 'style', visibility: 'attribute', opacity: '0.1', display: 'rule' });
  });

  it("puts the more specific rule first, and of two as specific the later", () => {
    const of = styled(`#p { fill: id } path.k { fill: both; stroke: both } .k { fill: class; stroke: class; opacity: 0.1 } path { fill: name; stroke: name; opacity: 0.2; mask: one } path { mask: two }`,
      `<path id="p" class="k"/>`);
    expect(of('p')).toEqual({ fill: 'id', stroke: 'both', opacity: '0.1', mask: 'two' });
  });

  it("takes only the attributes that set a property", () => {
    const of = styled('', `<rect id="r" x="1" width="5" fill="none" transform="scale(2)" data-x="y" class="k" xml:space="preserve"/>`);
    expect(of('r')).toEqual({ x: '1', width: '5', fill: 'none', transform: 'scale(2)' });
  });

  it("reads declarations with what values hold: colons, semicolons in parentheses, quotes, comments", () => {
    const declarations = SvgStyleSheet.declarations(`fill: url(data:image/png;base64,AA==); d: path("M0 0; L1 1") ;; stroke:red/*no*/; Mask : none !IMPORTANT; broken; : x; y:`);
    expect(Object.fromEntries([...declarations].map(([name, d]) => [name, d.important ? `${d.value} !` : d.value]))).toEqual({
      fill: 'url(data:image/png;base64,AA==)',
      d: 'path("M0 0; L1 1")',
      stroke: 'red',
      mask: 'none !',
    });
  });
});
