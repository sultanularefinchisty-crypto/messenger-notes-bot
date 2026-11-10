// Messenger Notes Chatbot
// - Admin page (/) to upload PDF / Word files or add Google Drive links
// - Answers questions using ONLY your notes, via the free Gemini API
// - Messenger webhook (/webhook) ready for when you connect Meta

const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- Settings (set these in Render "Environment") ----------
const {
  GEMINI_API_KEY, // free key from aistudio.google.com
  GEMINI_MODEL = "gemini-2.5-flash", // change here if Google renames the model
  ADMIN_PASSWORD, // password for your admin page
  VERIFY_TOKEN, // any word you invent; you'll type the same in Meta later
  PAGE_ACCESS_TOKEN, // from Meta (later)
  APP_SECRET, // from Meta (later, optional but recommended)
  PORT = 3000,
} = process.env;

// ---------- Notes storage (a simple JSON file) ----------
const DATA_DIR = path.join(__dirname, "data");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadNotes() {
  try {
    return JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

// Split long text into ~1000 character pieces
function chunkText(text) {
  const paragraphs = text.replace(/\r/g, "").split(/\n\s*\n/);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    const para = p.trim();
    if (!para) continue;
    if ((current + "\n\n" + para).length > 1000 && current) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------- Reading files ----------
async function extractText(buffer, hintName = "") {
  const head = buffer.slice(0, 5).toString("latin1");
  const lower = hintName.toLowerCase();

  if (head.startsWith("%PDF") || lower.endsWith(".pdf")) {
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (head.startsWith("PK") || lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (lower.endsWith(".doc")) {
    throw new Error("Old .doc files are not supported. Please save as .docx and try again.");
  }
  const asText = buffer.toString("utf8");
  if (/^\s*<!doctype html|^\s*<html/i.test(asText)) {
    throw new Error(
      "Google returned a web page, not the file. Set sharing to 'Anyone with the link can view'."
    );
  }
  return asText;
}

function parseDriveLink(url) {
  let m = url.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  if (m) return { kind: "gdoc", id: m[1] };
  m =
    url.match(/drive\.google\.com\/file\/d\/([\w-]+)/) ||
    url.match(/drive\.google\.com\/open\?id=([\w-]+)/) ||
    url.match(/[?&]id=([\w-]+)/);
  if (m) return { kind: "file", id: m[1] };
  return null;
}

async function fetchDriveLink(url) {
  const info = parseDriveLink(url);
  if (!info) throw new Error("That doesn't look like a Google Drive or Google Docs link.");
  const downloadUrl =
    info.kind === "gdoc"
      ? `https://docs.google.com/document/d/${info.id}/export?format=txt`
      : `https://drive.google.com/uc?export=download&id=${info.id}`;
  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Could not download the file (status ${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = await extractText(buffer, info.kind === "gdoc" ? "doc.txt" : "");
  return { name: "Drive: " + info.id.slice(0, 10) + "...", text };
}

// ---------- Finding the right notes for a question ----------
function findRelevantNotes(question) {
  const notes = loadNotes();
  const allChunks = notes.flatMap((n) => n.chunks.map((c) => ({ source: n.name, text: c })));
  const totalChars = allChunks.reduce((sum, c) => sum + c.text.length, 0);

  // Small notes: just send everything
  if (totalChars <= 30000) return allChunks;

  // Bigger notes: pick the best-matching pieces by keyword
  const words = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
  const scored = allChunks.map((c) => {
    const t = c.text.toLowerCase();
    let score = 0;
    for (const w of words) if (t.includes(w)) score++;
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

// ---------- Asking the AI ----------
const history = new Map(); // short memory per person

async function answerQuestion(userId, question) {
  const pieces = findRelevantNotes(question);
  if (pieces.length === 0) {
    return "I don't have any notes yet. Please ask the owner to upload some.";
  }

  const notesText = pieces.map((p, i) => `[Note ${i + 1} - ${p.source}]\n${p.text}`).join("\n\n---\n\n");

  const system =
    "You are a helpful assistant that answers questions using ONLY the notes below. " +
    "If the answer is not in the notes, say you don't have that information. " +
    "Reply in the same language the person writes in. Keep answers short and clear, " +
    "suitable for a chat message. Do not use markdown formatting.\n\n" +
    "NOTES:\n" +
    notesText;

  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");

  const past = history.get(userId) || [];
  const contents = [...past, { role: "user", parts: [{ text: question }] }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: 800, temperature: 0.3 },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini error ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content?.parts) || [];
  const reply = parts.map((p) => p.text || "").join("").trim();
  if (!reply) return "Sorry, I couldn't come up with an answer. Please try rephrasing.";

  history.set(userId, [...contents, { role: "model", parts: [{ text: reply }] }].slice(-6));
  return reply;
}

// ---------- Web server ----------
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Keep the raw body so we can verify Meta's signature
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(500).send("Set ADMIN_PASSWORD in Secrets first.");
  const header = req.headers.authorization || "";
  const [type, encoded] = header.split(" ");
  if (type === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString();
    const pass = decoded.split(":").slice(1).join(":");
    if (pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Notes Bot Admin"');
  res.status(401).send("Login required (leave username empty, use your admin password).");
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function adminPage(message = "") {
  const notes = loadNotes();
  const rows =
    notes
      .map(
        (n) => `<li>${esc(n.name)} <small>(${n.chunks.length} pieces)</small>
        <form method="post" action="/delete/${esc(n.id)}" style="display:inline">
          <button>Delete</button></form></li>`
      )
      .join("") || "<li>No notes yet.</li>";

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes Bot Admin</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5}
  fieldset{margin:1rem 0;padding:1rem;border-radius:8px}
  input[type=url]{width:100%;padding:.5rem;box-sizing:border-box}
  button{padding:.5rem 1rem;cursor:pointer}
  .msg{background:#eef;padding:.6rem;border-radius:6px}
  .test input{width:75%;padding:.5rem} #answer{white-space:pre-wrap;margin-top:.6rem}
</style></head><body>
<h1>Notes Bot Admin</h1>
${message ? `<p class="msg">${esc(message)}</p>` : ""}

<fieldset><legend>Upload a PDF or Word (.docx) file</legend>
<form method="post" action="/upload" enctype="multipart/form-data">
  <input type="file" name="file" accept=".pdf,.docx" required>
  <button>Upload</button>
</form></fieldset>

<fieldset><legend>Add a Google Drive / Google Docs link</legend>
<form method="post" action="/add-link">
  <input type="url" name="url" placeholder="https://drive.google.com/file/d/..." required>
  <p><small>The file must be shared as "Anyone with the link can view".</small></p>
  <button>Add link</button>
</form></fieldset>

<fieldset><legend>Your notes</legend><ul>${rows}</ul></fieldset>

<fieldset class="test"><legend>Test the bot</legend>
  <input id="q" placeholder="Ask a question about your notes">
  <button onclick="ask()">Ask</button>
  <div id="answer"></div>
</fieldset>

<script>
async function ask(){
  const out=document.getElementById('answer');
  out.textContent='Thinking...';
  const r=await fetch('/test',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({question:document.getElementById('q').value})});
  const d=await r.json();
  out.textContent=d.answer||d.error;
}
</script></body></html>`;
}

app.get("/", requireAdmin, (_req, res) => res.send(adminPage()));

async function addNote(name, text) {
  const clean = text.trim();
  if (!clean) throw new Error("No readable text found in that file.");
  const notes = loadNotes();
  notes.push({ id: crypto.randomUUID(), name, chunks: chunkText(clean) });
  saveNotes(notes);
}

app.post("/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Please choose a file.");
    const text = await extractText(req.file.buffer, req.file.originalname);
    await addNote(req.file.originalname, text);
    res.send(adminPage(`Added "${req.file.originalname}".`));
  } catch (err) {
    res.send(adminPage("Error: " + err.message));
  }
});

app.post("/add-link", requireAdmin, async (req, res) => {
  try {
    const { name, text } = await fetchDriveLink((req.body.url || "").trim());
    await addNote(name, text);
    res.send(adminPage(`Added "${name}".`));
  } catch (err) {
    res.send(adminPage("Error: " + err.message));
  }
});

app.post("/delete/:id", requireAdmin, (req, res) => {
  saveNotes(loadNotes().filter((n) => n.id !== req.params.id));
  res.send(adminPage("Deleted."));
});

// Test box on the admin page
app.post("/test", requireAdmin, async (req, res) => {
  try {
    const answer = await answerQuestion("admin-test", String(req.body.question || ""));
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.json({ error: "Something went wrong: " + err.message });
  }
});

// ---------- Messenger webhook (used later with Meta) ----------

// Meta calls this once to check your server is yours
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

function validSignature(req) {
  if (!APP_SECRET) return true; // skip check until you add APP_SECRET
  const sig = req.headers["x-hub-signature-256"] || "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function sendMessage(recipientId, text) {
  if (!PAGE_ACCESS_TOKEN) return console.log("No PAGE_ACCESS_TOKEN yet. Reply was:", text);
  // Messenger allows 2000 characters per message
  const parts = text.match(/[\s\S]{1,1900}/g) || [""];
  for (const part of parts) {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: "RESPONSE", message: { text: part } }),
      }
    );
    if (!r.ok) console.error("Send failed:", await r.text());
  }
}

app.post("/webhook", (req, res) => {
  if (!validSignature(req)) return res.sendStatus(403);
  res.sendStatus(200); // reply to Meta immediately, then work

  if (req.body.object !== "page") return;
  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender && event.sender.id;
      const text = event.message && event.message.text;
      if (!senderId || !text || event.message.is_echo) continue;

      answerQuestion(senderId, text)
        .then((reply) => sendMessage(senderId, reply))
        .catch((err) => {
          console.error(err);
          sendMessage(senderId, "Sorry, something went wrong. Please try again.");
        });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Notes bot running on port ${PORT}`));
