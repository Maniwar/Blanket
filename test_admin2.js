const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const html = fs.readFileSync('admin.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
setTimeout(() => {
  const views = dom.window.document.querySelectorAll('.view');
  views.forEach(v => {
    console.log(v.id, "display:", dom.window.getComputedStyle(v).display, "classes:", v.className);
  });
}, 2000);
