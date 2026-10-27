# EGX data publication contract

A market update is valid only when both decision-intelligence-v6.json and capital-recovery-alerts-v1.json share the latest verified completed EGX reference_session. Each published price must include its source, timestamp, and market session. A successful scheduler run is not proof of data freshness.

Fail closed: if the quote feed, financial research, Sharia screening, market breadth, or currency/macro evidence is missing, publish an explicit blocked diagnostic and no actionable buy orders. Never reuse yesterday's close as a live quote. Reconcile the market-wide buy gate across all engines before publishing alerts.

Budget: maximum new capital EGP 15,000; first tranche maximum EGP 6,000; EFID 16.70-16.80, EGAL 286-288 conditional only; JUFO second tranche; ISPH excluded. EGX30 close below 47,500 cancels new buys. Recovery 49,800-50,000 requires breadth and foreign-flow confirmation.

Do not represent any order as executed without user confirmation. Suppress repetitive no-change alerts, but report each newly detected critical data outage once.
