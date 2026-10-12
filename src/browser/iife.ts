// The entry of the <script> bundle: everything the browser half exports, and
// the element registered as soon as the script runs.
import { defineElement } from "./element.js";

export * from "./index.js";

if (typeof customElements !== "undefined") defineElement();
