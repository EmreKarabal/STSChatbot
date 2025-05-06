import express from "express";
import dotenv from "dotenv";
import { GenerateContentResponseHandler } from "@google-cloud/vertexai";

dotenv.config();
const { OPENAI_API_KEY, PORT = 3000 } = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌  OPENAI_API_KEY missing in .env");
  process.exit(1);
}

const app = express();
app.use(express.static("public"));

/* ---------- Realtime session ---------- */
app.get("/session", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview-2024-12-17",
        voice: "alloy",
        instructions: "Tüm yanıtlarını Türkçe ver."
      })
    });

    if (!r.ok) return res.status(500).json({ error: await r.text() });
    res.json(await r.json());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create Realtime session" });
  }
});

/* ---------- TOOL: hava durumu ---------- */
app.get("/tool/weather", async (req, res) => {
  const city = req.query.city;
  if (!city) return res.status(400).json({ error: "city param missing" });

  try {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    const data = await r.json();
    const c = data.current_condition?.[0];
    res.json({
      city,
      temp: c?.temp_C,
      description: c?.weatherDesc?.[0]?.value
    });
  } catch {
    res.status(500).json({ error: "Weather fetch failed" });
  }
});

/* ---------- TOOL: döviz kuru ---------- */
app.get("/tool/rate", async (req, res) => {
  const base = (req.query.base || "USD").toUpperCase();
  const target = (req.query.target || "TRY").toUpperCase();

  try {
    /* 1. ana kaynak */
    let r = await fetch(`https://api.exchangerate.host/latest?base=${base}&symbols=${target}`);
    let data = await r.json();
    let rate = data.rates?.[target];

    /* 2. yedek kaynak */
    if (rate === undefined) {
      r = await fetch(`https://open.er-api.com/v6/latest/${base}`);
      data = await r.json();
      rate = data.rates?.[target];
    }

    if (rate === undefined)
      return res.status(502).json({ error: "Rate not found in both APIs" });

    res.json({ base, target, rate });

  } catch (e) {
    console.error("rate error:", e);
    res.status(500).json({ error: "Rate fetch failed" });
  }
});

app.get("/tool/metar", async (req, res) => {
  
  try {

    const icao = req.query.icao;
    const headers = {
      'x-api-key': process.env.CHECKWX_API_KEY
    };

    let response = await fetch(`https://api.checkwx.com/metar/${icao}`, {
      headers: headers
    });
    let data = await response.json();

    res.json({
      metar: data
    });
  } catch (error) {

    console.error(error);
    res.status(500).json({ error: "Metar fetch failed! "});

  }
})

app.listen(PORT, () =>
  console.log(`✅  Voice bot server running → http://localhost:${PORT}`)
);