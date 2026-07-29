# Flight Stock — PoC della pipeline di esecuzione

Prototipo tecnico della **Fase 0** (v. `docs/FLIGHT_STOCK.md`, §16): dimostra che la catena completa di acquisto funziona, dal trovare il volo all'emettere il biglietto, **senza soldi veri e senza biglietti veri**.

## Cosa fa

Percorre i sei passi della "saga" di esecuzione descritta nel documento (§7.2):

1. **Ricerca** delle offerte per la rotta e la data dell'ordine (API Duffel).
2. **Filtro sulle condizioni dell'ordine**: tiene solo le offerte con prezzo per persona ≤ alla soglia impostata, numero di scali ≤ al massimo consentito e durata del viaggio ≤ alla durata massima; il log mostra il motivo di ogni esclusione.
3. **Verifica live del prezzo**: ricontrolla l'offerta in tempo reale prima di procedere — mai comprare su un prezzo in cache.
4. **Pre-autorizzazione** dell'importo sulla carta (Stripe, cattura manuale): i soldi vengono bloccati ma non prelevati.
5. **Emissione del biglietto** (ordine Duffel) → PNR.
6. **Cattura del pagamento**: solo a biglietto emesso l'utente paga davvero.

Se l'emissione fallisce dopo la pre-autorizzazione, scatta la **compensazione**: il blocco sulla carta viene annullato e nessun addebito arriva all'utente. È la garanzia "zero doppi addebiti / zero addebiti senza biglietto" del documento (RNF-02, RF-EXE-03).

## Requisiti

- Node.js ≥ 18 (nessuna dipendenza da installare: usa solo la libreria standard).

## Come si esegue

### Modalità simulata (subito, senza account)

Senza chiavi API lo script usa risposte simulate ma percorre esattamente lo stesso codice:

```bash
node poc/flight-stock-poc.mjs                  # percorso felice: trigger → biglietto → pagamento
node poc/flight-stock-poc.mjs --fail-issuance  # demo della compensazione (emissione fallita → storno)
node poc/flight-stock-poc.mjs --strike 5000    # strike a 50.00 EUR/pax: nessun trigger, si continua a monitorare
node poc/flight-stock-poc.mjs --max-stops 0    # solo voli diretti: cambia quale offerta viene scelta
node poc/flight-stock-poc.mjs --max-duration 180  # max 3 ore di viaggio
```

### Modalità sandbox (API di test reali)

1. Crea un account gratuito su [duffel.com](https://duffel.com) → copia un **test token** (`duffel_test_...`).
2. Crea un account su [stripe.com](https://stripe.com) → copia la **chiave segreta di test** (`sk_test_...`).
3. Esegui:

```bash
DUFFEL_API_KEY=duffel_test_xxx STRIPE_SECRET_KEY=sk_test_xxx \
  node poc/flight-stock-poc.mjs --origin MXP --destination LIS --strike 12000
```

In sandbox Duffel restituisce offerte fittizie del vettore di test "Duffel Airways" e l'emissione produce un PNR di prova; Stripe usa la carta di test `pm_card_visa`. Nessun costo, nessun volo reale.

### Opzioni

| Opzione | Significato | Default |
|---|---|---|
| `--origin` / `--destination` | Aeroporti IATA | `MXP` / `LIS` |
| `--date` | Data partenza (YYYY-MM-DD) | un venerdì fra ~3 settimane |
| `--strike` | Prezzo massimo per persona in **centesimi** | `12000` (120.00 EUR) |
| `--max-stops` | Numero massimo di scali (0 = solo diretti) | `1` |
| `--max-duration` | Durata massima del viaggio per tratta, in **minuti** | `420` (7 ore) |
| `--fail-issuance` | Simula il fallimento dell'emissione (solo mock) | — |
| `--mock` | Forza la modalità simulata anche con le chiavi presenti | — |

## Cosa dimostra (e cosa no)

**Dimostra**: la fattibilità tecnica della pipeline, l'ordine corretto delle operazioni (mai catturare prima di emettere), la compensazione automatica, l'uso delle idempotency key contro i doppi acquisti.

**Non è**: il prodotto. Mancano il monitoraggio continuo (Fare Watcher), il database ordini, le notifiche, il mandato di pagamento dell'utente reale (SCA/MIT) e tutto ciò che è descritto nel documento di sviluppo. Questo script è il "filo" che il sistema vero dovrà industrializzare.
