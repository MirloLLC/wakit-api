# wakit vs Twilio — Pricing Comparison

## How pricing works

### Twilio
Every WhatsApp message has two costs:
1. **Twilio fee**: $0.005/message (flat, always charged)
2. **Meta fee**: varies by message type and service window (pass-through)

### wakit
1. **wakit fee**: fixed monthly plan ($0 / $20 / $249)
2. **Meta fee**: same as above — paid directly to Meta (pass-through)

The Meta fee is identical in both cases. **The savings come from replacing Twilio's $0.005/message with wakit's fixed plan.**

## Meta fee reference (US pricing)

| Message type | Inside service window (24h) | Outside service window |
|-------------|---------------------------|----------------------|
| Free-form (text) | $0.00 | Cannot send |
| Utility template | $0.00 | $0.0085/msg |
| Marketing template | $0.0305/msg | $0.0305/msg |
| Authentication template | $0.00 | $0.00 |

## wakit plans

| Plan | wakit fee | Messages included | Storage | Phone numbers |
|------|-----------|-------------------|---------|---------------|
| Free | $0 | 2,000/mo | 500 MB | 1 |
| Starter | $20/mo | 50,000/mo | 5 GB | 5 |
| Pro | $249/mo | 1,000,000/mo | 50 GB | Unlimited |

## Scenario 1: Customer support
*80% free-form inside service window, 20% utility templates outside window*

| Volume/mo | Twilio fee | Meta fee | wakit fee | Meta fee | Total Twilio | Total wakit | Savings |
|-----------|-----------|----------|-----------|----------|-------------|-------------|---------|
| 2,000 | $10 | $3.40 | $0 (Free) | $3.40 | **$13.40** | **$3.40** | **$10** (75%) |
| 5,000 | $25 | $8.50 | $0 (Free) | $8.50 | **$33.50** | **$8.50** | **$25** (75%) |
| 10,000 | $50 | $17 | $20 (Starter) | $17 | **$67** | **$37** | **$30** (45%) |
| 50,000 | $250 | $85 | $20 (Starter) | $85 | **$335** | **$105** | **$230** (69%) |
| 100,000 | $500 | $170 | $249 (Pro) | $170 | **$670** | **$419** | **$251** (37%) |
| 300,000 | $1,500 | $510 | $249 (Pro) | $510 | **$2,010** | **$759** | **$1,251** (62%) |
| 500,000 | $2,500 | $850 | $249 (Pro) | $850 | **$3,350** | **$1,099** | **$2,251** (67%) |
| 1,000,000 | $5,000 | $1,700 | $249 (Pro) | $1,700 | **$6,700** | **$1,949** | **$4,751** (71%) |

## Scenario 2: Pure marketing
*100% marketing templates (outside service window)*

| Volume/mo | Twilio fee | Meta fee | wakit fee | Meta fee | Total Twilio | Total wakit | Savings |
|-----------|-----------|----------|-----------|----------|-------------|-------------|---------|
| 1,000 | $5 | $30.50 | $0 (Free) | $30.50 | **$35.50** | **$30.50** | **$5** (14%) |
| 10,000 | $50 | $305 | $20 (Starter) | $305 | **$355** | **$325** | **$30** (8%) |
| 50,000 | $250 | $1,525 | $20 (Starter) | $1,525 | **$1,775** | **$1,545** | **$230** (13%) |
| 100,000 | $500 | $3,050 | $249 (Pro) | $3,050 | **$3,550** | **$3,299** | **$251** (7%) |
| 300,000 | $1,500 | $9,150 | $249 (Pro) | $9,150 | **$10,650** | **$9,399** | **$1,251** (12%) |
| 500,000 | $2,500 | $15,250 | $249 (Pro) | $15,250 | **$17,750** | **$15,499** | **$2,251** (13%) |
| 1,000,000 | $5,000 | $30,500 | $249 (Pro) | $30,500 | **$35,500** | **$30,749** | **$4,751** (13%) |

## Scenario 3: Mixed (typical business)
*50% free-form inside window, 30% utility templates, 20% marketing templates*

| Volume/mo | Twilio fee | Meta fee | wakit fee | Meta fee | Total Twilio | Total wakit | Savings |
|-----------|-----------|----------|-----------|----------|-------------|-------------|---------|
| 2,000 | $10 | $17.26 | $0 (Free) | $17.26 | **$27.26** | **$17.26** | **$10** (37%) |
| 10,000 | $50 | $86.30 | $20 (Starter) | $86.30 | **$136.30** | **$106.30** | **$30** (22%) |
| 50,000 | $250 | $431.50 | $20 (Starter) | $431.50 | **$681.50** | **$451.50** | **$230** (34%) |
| 100,000 | $500 | $863 | $249 (Pro) | $863 | **$1,363** | **$1,112** | **$251** (18%) |
| 300,000 | $1,500 | $2,589 | $249 (Pro) | $2,589 | **$4,089** | **$2,838** | **$1,251** (31%) |
| 500,000 | $2,500 | $4,315 | $249 (Pro) | $4,315 | **$6,815** | **$4,564** | **$2,251** (33%) |
| 1,000,000 | $5,000 | $8,630 | $249 (Pro) | $8,630 | **$13,630** | **$8,879** | **$4,751** (35%) |

## Key takeaways

1. **The savings are always the Twilio fee** ($0.005/msg) minus the wakit plan cost
2. **Meta fee is identical** — it cancels out in the comparison
3. **Support-heavy businesses save the most %** because Meta fee is low (free-form in window = $0)
4. **Marketing-heavy businesses save less %** because Meta fee dominates, but still save the full Twilio fee
5. **At scale (100k+ msgs), wakit Pro pays for itself** and saves $251+/month
6. **At 1M msgs, savings are ~$4,751/month ($57K/year)**
7. **Breakeven points**: Free plan covers up to 2,000 msgs; Starter breaks even at 4,000 msgs ($20/$0.005); Pro breaks even at 49,800 msgs

## Migration wizard

The Twilio migration wizard (`/api/migrate-twilio/detail`) now:
- Classifies messages by type (template vs free-form) from Twilio's API
- Shows the full breakdown: Twilio fee + Meta fee vs wakit fee + Meta fee
- Clarifies that Meta fees are identical in both platforms
- Recommends the optimal wakit plan based on actual volume
