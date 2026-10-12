// The page's own script: shows what the element reports. The page never sees
// a claim; the server does, after the exchange or a status read.
const log = document.getElementById("log");
const line = (text) => {
  log.textContent += `${new Date().toISOString().slice(11, 19)} ${text}\n`;
};
line(`detected: ${JSON.stringify(VerySafeVerify.detect())}`);
document.addEventListener("verysafe-verify:flow", (e) => line(`flow: ${e.detail.flow}`));
document.addEventListener("verysafe-verify:status", (e) => line(`status: ${e.detail.status}`));
document.addEventListener("verysafe-verify:result", (e) => line(`result: ${JSON.stringify(e.detail)}`));
