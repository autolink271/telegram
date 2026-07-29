#!/usr/bin/env node
/**
 * Flight Stock — PoC pipeline di esecuzione (Fase 0, §16 del documento).
 *
 * Percorre end-to-end la saga di acquisto:
 *   1. Ricerca offerte           (Duffel: offer request)
 *   2. Filtro sullo strike       (prezzo per persona ≤ soglia utente)
 *   3. Verifica live del prezzo  (Duffel: get offer — mai comprare su cache)
 *   4. Pre-autorizzazione fondi  (Stripe: PaymentIntent, capture manuale)
 *   5. Emissione biglietto       (Duffel: create order)
 *   6. Cattura del pagamento     (Stripe: capture)
 *   Compensazione: se l'emissione fallisce dopo l'autorizzazione,
 *   la pre-autorizzazione viene annullata (nessun addebito all'utente).
 *
 * Modalità:
 *   - MOCK (default senza chiavi): risposte simulate, nessuna rete richiesta.
 *   - SANDBOX: esporta DUFFEL_API_KEY (test) e STRIPE_SECRET_KEY (sk_test_...).
 *
 * Uso:
 *   node flight-stock-poc.mjs                        # mock, percorso felice
 *   node flight-stock-poc.mjs --fail-issuance        # mock, demo compensazione
 *   node flight-stock-poc.mjs --strike 5000          # strike 50.00 EUR/pax
 *   DUFFEL_API_KEY=... STRIPE_SECRET_KEY=... node flight-stock-poc.mjs
 */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

// ---------------------------------------------------------------------------
// Ordine condizionato d'esempio (in produzione arriva dal database ordini)
// ---------------------------------------------------------------------------
const order = {
  id: `ord_${Date.now()}`,
  origin: opt("origin", "MXP"),
  destination: opt("destination", "LIS"),
  departDate: opt("date", nextFriday()),
  pax: 1,
  cabin: "economy",
  strikePerPaxCents: parseInt(opt("strike", "12000"), 10), // 120.00
  currency: "EUR",
  maxStops: parseInt(opt("max-stops", "1"), 10),            // 0|1|2
  maxDurationMinutes: parseInt(opt("max-duration", "420"), 10), // per tratta
  mode: "SOFT",
};

const MOCK = flag("mock") || !(process.env.DUFFEL_API_KEY && process.env.STRIPE_SECRET_KEY);
const FAIL_ISSUANCE = flag("fail-issuance");

// La stessa idempotency key protegge Stripe e Duffel dai doppi acquisti (RNF-02)
const triggerId = `trg_${Date.now()}`;
const idempotencyKey = `${order.id}:${triggerId}`;

function nextFriday() {
  const d = new Date();
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7) + 21); // ~3 settimane
  return d.toISOString().slice(0, 10);
}

const eur = (cents) => `${(cents / 100).toFixed(2)} ${order.currency}`;
const log = (step, msg) => console.log(`[${step}] ${msg}`);

// "PT4H30M" → minuti (formato durate Duffel)
const isoMinutes = (s) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(s ?? "");
  return m && (m[1] || m[2]) ? (parseInt(m[1] ?? "0", 10) * 60 + parseInt(m[2] ?? "0", 10)) : Infinity;
};

// Scali e durata dell'offerta, valutati sulla tratta peggiore
const itinerary = (offer) => ({
  stops: Math.max(...offer.slices.map((s) => (s.segments?.length ?? 1) - 1)),
  minutes: Math.max(...offer.slices.map((s) => isoMinutes(s.duration))),
});
const fmtDur = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Client Duffel (REST, nessuna dipendenza) + variante mock
// ---------------------------------------------------------------------------
const duffel = MOCK ? mockDuffel() : realDuffel(process.env.DUFFEL_API_KEY);

function realDuffel(apiKey) {
  const call = async (method, path, body) => {
    const res = await fetch(`https://api.duffel.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Duffel-Version": "v2",
        "Content-Type": "application/json",
        ...(method === "POST" ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body ? JSON.stringify({ data: body }) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Duffel ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
    return json.data;
  };
  return {
    searchOffers: async () => {
      const req = await call("POST", "/air/offer_requests?return_offers=true", {
        slices: [{ origin: order.origin, destination: order.destination, departure_date: order.departDate }],
        passengers: Array.from({ length: order.pax }, () => ({ type: "adult" })),
        cabin_class: order.cabin,
      });
      return req.offers ?? [];
    },
    priceConfirm: (offerId) => call("GET", `/air/offers/${offerId}`),
    createOrder: (offer) =>
      call("POST", "/air/orders", {
        type: "instant",
        selected_offers: [offer.id],
        payments: [{ type: "balance", currency: offer.total_currency, amount: offer.total_amount }],
        passengers: offer.passengers.map((p) => ({
          id: p.id,
          title: "ms",
          given_name: "Giulia",
          family_name: "Rossi",
          gender: "f",
          born_on: "1992-03-14",
          email: "giulia.rossi@example.com",
          phone_number: "+390212345678",
        })),
      }),
  };
}

function mockDuffel() {
  const catalog = {
    off_mock_high: { cents: 16300, stops: 0, minutes: 170 }, // diretto ma caro
    off_mock_ok:   { cents: 10950, stops: 1, minutes: 370 }, // 1 scalo, 6h10 ✓
    off_mock_mid:  { cents: 12800, stops: 0, minutes: 165 }, // diretto, sopra strike
    off_mock_slow: { cents:  9500, stops: 2, minutes: 680 }, // economico ma 2 scali, 11h20
  };
  const mkOffer = (id) => {
    const { cents, stops, minutes } = catalog[id];
    return {
      id,
      owner: { iata_code: "TP", name: "TAP Air Portugal" },
      total_amount: (cents / 100).toFixed(2),
      total_currency: order.currency,
      slices: [{
        duration: `PT${Math.floor(minutes / 60)}H${minutes % 60}M`,
        segments: Array.from({ length: stops + 1 }, (_, i) => ({ id: `seg_${id}_${i}` })),
      }],
      passengers: [{ id: "pas_mock_1" }],
    };
  };
  return {
    searchOffers: async () => Object.keys(catalog).map(mkOffer),
    priceConfirm: async (offerId) =>
      // Al re-pricing live il prezzo può essere cambiato: qui resta valido.
      mkOffer(offerId),
    createOrder: async (offer) => {
      if (FAIL_ISSUANCE) throw new Error("mock: il vettore ha rifiutato l'emissione (posti esauriti)");
      return { id: "ord_duffel_mock", booking_reference: "ABC123", offer_id: offer.id };
    },
  };
}

// ---------------------------------------------------------------------------
// Client Stripe (REST, nessuna dipendenza) + variante mock
// ---------------------------------------------------------------------------
const stripe = MOCK ? mockStripe() : realStripe(process.env.STRIPE_SECRET_KEY);

function realStripe(secretKey) {
  const call = async (path, params) => {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `${idempotencyKey}:${path}`,
      },
      body: new URLSearchParams(params),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${json.error?.message}`);
    return json;
  };
  return {
    // capture_method=manual: prima si autorizza, si cattura solo a biglietto emesso
    authorize: (amountCents) =>
      call("/payment_intents", {
        amount: String(amountCents),
        currency: order.currency.toLowerCase(),
        capture_method: "manual",
        confirm: "true",
        payment_method: "pm_card_visa", // carta di test Stripe
        "automatic_payment_methods[enabled]": "true",
        "automatic_payment_methods[allow_redirects]": "never",
        description: `Flight Stock ${order.id} ${order.origin}-${order.destination}`,
      }),
    capture: (piId) => call(`/payment_intents/${piId}/capture`, {}),
    cancel: (piId) => call(`/payment_intents/${piId}/cancel`, { cancellation_reason: "abandoned" }),
  };
}

function mockStripe() {
  return {
    authorize: async (amountCents) => ({ id: "pi_mock_123", status: "requires_capture", amount: amountCents }),
    capture: async (piId) => ({ id: piId, status: "succeeded" }),
    cancel: async (piId) => ({ id: piId, status: "canceled" }),
  };
}

// ---------------------------------------------------------------------------
// La saga di esecuzione (§7.2 del documento)
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Flight Stock PoC — modalità ${MOCK ? "MOCK (simulata)" : "SANDBOX (API reali di test)"}\n`);
  log("ordine", `${order.origin} → ${order.destination} il ${order.departDate}, ` +
    `${order.pax} pax, strike ${eur(order.strikePerPaxCents)}/pax, ` +
    `max ${order.maxStops} scali, durata max ${fmtDur(order.maxDurationMinutes)} (id ${order.id})`);

  // 1. Ricerca
  const offers = await duffel.searchOffers();
  log("ricerca", `${offers.length} offerte trovate`);
  for (const o of offers) {
    const it = itinerary(o);
    log("ricerca", `  ${o.id} — ${o.owner?.name ?? "?"} — ${o.total_amount} ${o.total_currency}` +
      ` — ${it.stops} scali, ${fmtDur(it.minutes)}`);
  }

  // 2. Filtro sulle condizioni dell'ordine: strike per persona, scali, durata (RF-ORD-01)
  const eligible = offers
    .map((o) => ({ ...o, perPaxCents: Math.round((parseFloat(o.total_amount) * 100) / order.pax), it: itinerary(o) }))
    .filter((o) => {
      const reasons = [];
      if (o.total_currency !== order.currency) reasons.push(`valuta ${o.total_currency}`);
      if (o.perPaxCents > order.strikePerPaxCents) reasons.push(`prezzo ${eur(o.perPaxCents)} > strike`);
      if (o.it.stops > order.maxStops) reasons.push(`${o.it.stops} scali > max ${order.maxStops}`);
      if (o.it.minutes > order.maxDurationMinutes) reasons.push(`durata ${fmtDur(o.it.minutes)} > max ${fmtDur(order.maxDurationMinutes)}`);
      if (reasons.length) log("filtro", `  esclusa ${o.id}: ${reasons.join(", ")}`);
      return reasons.length === 0;
    })
    .sort((a, b) => a.perPaxCents - b.perPaxCents);

  if (eligible.length === 0) {
    log("filtro", `nessuna offerta soddisfa tutte le condizioni: l'ordine resta ACTIVE, si continua a monitorare`);
    return;
  }
  const candidate = eligible[0];
  log("trigger", `offerta ${candidate.id} a ${eur(candidate.perPaxCents)}/pax, ` +
    `${candidate.it.stops} scali, ${fmtDur(candidate.it.minutes)} — tutte le condizioni soddisfatte → TRIGGERED`);

  // 3. Verifica live: la cache decide quando guardare, mai cosa comprare (RF-EXE-02)
  const live = await duffel.priceConfirm(candidate.id);
  const liveCents = Math.round((parseFloat(live.total_amount) * 100) / order.pax);
  const liveIt = itinerary(live);
  if (liveCents > order.strikePerPaxCents) {
    log("verifica", `prezzo live ${eur(liveCents)} > strike: niente acquisto, ordine di nuovo ACTIVE`);
    return;
  }
  if (liveIt.stops > order.maxStops || liveIt.minutes > order.maxDurationMinutes) {
    log("verifica", `itinerario live fuori condizioni (${liveIt.stops} scali, ${fmtDur(liveIt.minutes)}): niente acquisto`);
    return;
  }
  log("verifica", `confermato live: ${eur(liveCents)}/pax, ${liveIt.stops} scali, ${fmtDur(liveIt.minutes)} — si procede`);

  // 4. Pre-autorizzazione fondi (nessuna cattura prima dell'emissione)
  const totalCents = Math.round(parseFloat(live.total_amount) * 100);
  const pi = await stripe.authorize(totalCents);
  log("pagamento", `pre-autorizzati ${eur(totalCents)} (PaymentIntent ${pi.id}, stato ${pi.status})`);

  // 5. Emissione — con compensazione in caso di fallimento
  let ticket;
  try {
    ticket = await duffel.createOrder(live);
  } catch (err) {
    log("emissione", `FALLITA: ${err.message}`);
    const canceled = await stripe.cancel(pi.id);
    log("compensazione", `pre-autorizzazione annullata (${canceled.status}): nessun addebito, ordine torna ACTIVE`);
    process.exitCode = 1;
    return;
  }
  log("emissione", `biglietto emesso — PNR ${ticket.booking_reference} (duffel ${ticket.id})`);

  // 6. Cattura: solo ora l'utente paga davvero
  const captured = await stripe.capture(pi.id);
  log("pagamento", `catturati ${eur(totalCents)} (${captured.status})`);

  log("fine", `ordine ${order.id} → FILLED. Eseguito a ${eur(liveCents)}/pax contro uno strike di ${eur(order.strikePerPaxCents)}/pax.`);
}

main().catch((err) => {
  console.error(`\nErrore imprevisto: ${err.message}`);
  process.exitCode = 1;
});
