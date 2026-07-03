const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const html = fs.readFileSync('admin.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "dangerously" });
setTimeout(() => {
  const el = dom.window.document.getElementById('view-setup');
  console.log("Class list:", el.className);
  console.log("Computed display:", dom.window.getComputedStyle(el).display);
}, 500);
