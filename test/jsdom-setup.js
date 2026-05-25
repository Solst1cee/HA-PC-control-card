// Installs a minimal DOM into Node globals so importing the card module
// (which extends HTMLElement and calls customElements.define at load)
// works under `node --test`. Imported first by every test file.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.customElements = dom.window.customElements;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Node = dom.window.Node;
