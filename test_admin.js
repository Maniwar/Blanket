const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

const html = fs.readFileSync('admin.html', 'utf8');
const dom = new JSDOM(html, { runScripts: "dangerously", resources: "usable" });
setTimeout(() => {
  console.log("Displayed view:", dom.window.document.querySelector('.view.on').id);
  console.log(dom.window.document.getElementById('setup-msg').textContent);
}, 2000);
