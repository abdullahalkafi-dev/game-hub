// The /admin page. It is plain HTML and JavaScript served by the game server itself, so it adds nothing
// to the game bundle. The client script deliberately avoids template literals so this file can hold it
// as one raw string.
export const ADMIN_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>StrikeCore Admin</title>
<style>
:root{color-scheme:dark;--bg:#0b1220;--card:#121c30;--line:#24324d;--fg:#e6edf7;--mut:#8da0bd;--cy:#38bdf8;--am:#fbbf24;--red:#f87171;--ok:#4ade80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:18px 16px 60px}
h1{font-size:22px;margin:0}
h2{font-size:15px;margin:0}
p{color:var(--mut);margin:4px 0}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.login{max-width:360px;margin:12vh auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px}
input[type=password],input[type=text],select{width:100%;background:#0b1424;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px 10px;font:inherit}
button{background:var(--cy);color:#04141f;border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:700;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.danger{background:transparent;color:var(--red);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.tools input,.tools select{width:auto;min-width:180px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.tag{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--cy)}
.drop{border:1.5px dashed var(--line);border-radius:10px;padding:12px;text-align:center;color:var(--mut);cursor:pointer;font-size:13px}
.drop.over{border-color:var(--cy);color:var(--fg)}
.drop input{display:none}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.up{background:#0e1626;border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.up b{font-size:13px}
.meta{font-size:12px;color:var(--mut)}
.bar{height:6px;background:#0b1424;border-radius:3px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--cy)}
.msg{font-size:13px;min-height:18px}
.msg.err{color:var(--red)}.msg.ok{color:var(--ok)}
.empty{color:var(--mut);font-size:13px}
#viewer{position:fixed;inset:0;background:rgba(5,9,16,.88);display:none;align-items:center;justify-content:center;padding:16px;z-index:10}
#viewer .box{background:var(--card);border:1px solid var(--line);border-radius:12px;width:min(900px,100%);padding:12px}
#viewer model-viewer{width:100%;height:min(60vh,520px);background:#0b1424;border-radius:8px}
</style>
</head>
<body>
<div id="login" class="login">
  <h1>StrikeCore Admin</h1>
  <p>Enter the admin password to manage weapon model uploads.</p>
  <p><input id="pw" type="password" autocomplete="current-password" placeholder="Password"></p>
  <p><button id="pw-go">Sign in</button></p>
  <div id="login-msg" class="msg err"></div>
</div>

<div id="app" class="wrap" hidden>
  <div class="top">
    <div>
      <h1>Weapon model uploads</h1>
      <p>Upload a <b>.glb</b> for any weapon. Files are stored privately and are <b>not</b> added to the game until they have been checked and optimised.</p>
    </div>
    <button class="ghost" id="logout">Sign out</button>
  </div>
  <div class="tools">
    <input id="filter" type="text" placeholder="Search guns">
    <select id="cat"><option value="">All types</option></select>
  </div>
  <div id="grid" class="grid"></div>
</div>

<div id="viewer"><div class="box">
  <div class="row" style="justify-content:space-between;margin-bottom:8px"><b id="viewer-title"></b><button class="ghost" id="viewer-close">Close</button></div>
  <div id="viewer-host"></div>
</div></div>

<script>
(function () {
  var pw = sessionStorage.getItem("adminPw") || "";
  var state = { guns: [], uploads: [], maxBytes: 100 * 1024 * 1024 };
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function mb(bytes) { return (bytes / 1048576).toFixed(1) + " MB"; }

  function api(method, path, body, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, path);
      xhr.setRequestHeader("x-admin-password", pw);
      xhr.responseType = "text";
      if (onProgress && xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || ("Request failed (" + xhr.status + ")")));
      };
      xhr.onerror = function () { reject(new Error("Network error. The upload may be too large or the connection dropped.")); };
      xhr.send(body || null);
    });
  }

  function signIn(password) {
    pw = password;
    return api("GET", "/api/admin/session").then(function () {
      sessionStorage.setItem("adminPw", pw);
      $("login").hidden = true;
      $("app").hidden = false;
      return refresh();
    });
  }

  function refresh() {
    return api("GET", "/api/admin/guns").then(function (data) {
      state.guns = data.guns;
      state.uploads = data.uploads;
      state.maxBytes = data.maxBytes;
      var cats = {};
      data.guns.forEach(function (g) { cats[g.category] = true; });
      var select = $("cat");
      var current = select.value;
      select.length = 1;
      Object.keys(cats).sort().forEach(function (c) {
        var o = el("option", "", c); o.value = c; select.appendChild(o);
      });
      select.value = current;
      render();
    });
  }

  function render() {
    var q = $("filter").value.trim().toLowerCase();
    var cat = $("cat").value;
    var grid = $("grid");
    grid.textContent = "";
    state.guns.filter(function (g) {
      return (!cat || g.category === cat) && (!q || g.name.toLowerCase().indexOf(q) >= 0 || g.id.indexOf(q) >= 0);
    }).forEach(function (gun) { grid.appendChild(card(gun)); });
  }

  function card(gun) {
    var c = el("div", "card");
    var head = el("header");
    head.appendChild(el("h2", "", gun.name));
    head.appendChild(el("span", "tag", gun.category + " / " + gun.id));
    c.appendChild(head);

    var label = el("input"); label.type = "text"; label.placeholder = "Name for this model (e.g. Gold Edition)"; label.maxLength = 60;
    c.appendChild(label);

    var drop = el("div", "drop", "Drop a .glb here or click to choose (max " + mb(state.maxBytes) + ")");
    var file = el("input"); file.type = "file"; file.accept = ".glb,model/gltf-binary";
    drop.appendChild(file);
    c.appendChild(drop);

    var bar = el("div", "bar"); var fill = el("i"); bar.appendChild(fill); bar.hidden = true; c.appendChild(bar);
    var msg = el("div", "msg"); c.appendChild(msg);

    function upload(f) {
      if (!f) return;
      if (!/\.glb$/i.test(f.name)) { msg.className = "msg err"; msg.textContent = "Only .glb files are accepted."; return; }
      if (f.size > state.maxBytes) { msg.className = "msg err"; msg.textContent = "That file is " + mb(f.size) + ", over the " + mb(state.maxBytes) + " limit."; return; }
      var name = label.value.trim() || f.name.replace(/\.glb$/i, "");
      bar.hidden = false; fill.style.width = "0";
      msg.className = "msg"; msg.textContent = "Uploading " + f.name + " (" + mb(f.size) + ")...";
      var qs = "?weaponId=" + encodeURIComponent(gun.id) + "&label=" + encodeURIComponent(name) + "&filename=" + encodeURIComponent(f.name);
      api("POST", "/api/admin/uploads" + qs, f, function (p) { fill.style.width = Math.round(p * 100) + "%"; })
        .then(function () { return refresh(); })
        .catch(function (e) { bar.hidden = true; msg.className = "msg err"; msg.textContent = e.message; });
    }
    file.onchange = function () { upload(file.files[0]); file.value = ""; };
    drop.onclick = function (e) { if (e.target !== file) file.click(); };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = function () { drop.classList.remove("over"); };
    drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files[0]); };

    var mine = state.uploads.filter(function (u) { return u.weaponId === gun.id; });
    if (!mine.length) c.appendChild(el("div", "empty", "No uploads yet."));
    mine.forEach(function (u) {
      var box = el("div", "up");
      box.appendChild(el("b", "", u.label));
      box.appendChild(el("div", "meta", u.originalName + " - " + mb(u.bytes) + " - " + new Date(u.createdAt).toLocaleString()));
      var row = el("div", "row");
      var view = el("button", "ghost", "Preview"); view.onclick = function () { preview(u); };
      var del = el("button", "danger", "Delete");
      del.onclick = function () {
        if (!confirm("Delete \"" + u.label + "\"?")) return;
        api("DELETE", "/api/admin/uploads/" + u.id).then(refresh).catch(function (e) { alert(e.message); });
      };
      row.appendChild(view); row.appendChild(del); box.appendChild(row);
      c.appendChild(box);
    });
    return c;
  }

  var viewerLoaded = false;
  function preview(u) {
    $("viewer").style.display = "flex";
    $("viewer-title").textContent = u.label + " (" + u.weaponId + ")";
    var host = $("viewer-host");
    host.textContent = "Loading...";
    if (!viewerLoaded) {
      var s = document.createElement("script");
      s.type = "module";
      s.src = "https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js";
      document.head.appendChild(s);
      viewerLoaded = true;
    }
    fetch("/api/admin/uploads/" + u.id + "/file", { headers: { "x-admin-password": pw } })
      .then(function (r) { if (!r.ok) throw new Error("Could not load the file."); return r.blob(); })
      .then(function (blob) {
        host.textContent = "";
        var mv = document.createElement("model-viewer");
        mv.setAttribute("camera-controls", "");
        mv.setAttribute("auto-rotate", "");
        mv.setAttribute("shadow-intensity", "1");
        mv.setAttribute("exposure", "1");
        mv.src = URL.createObjectURL(blob);
        host.appendChild(mv);
      })
      .catch(function (e) { host.textContent = e.message; });
  }
  $("viewer-close").onclick = function () { $("viewer").style.display = "none"; $("viewer-host").textContent = ""; };

  $("pw-go").onclick = function () {
    $("login-msg").textContent = "";
    signIn($("pw").value).catch(function (e) { $("login-msg").textContent = e.message; });
  };
  $("pw").onkeydown = function (e) { if (e.key === "Enter") $("pw-go").click(); };
  $("logout").onclick = function () { sessionStorage.removeItem("adminPw"); location.reload(); };
  $("filter").oninput = render;
  $("cat").onchange = render;

  if (pw) signIn(pw).catch(function () { sessionStorage.removeItem("adminPw"); });
})();
</script>
</body>
</html>`;
