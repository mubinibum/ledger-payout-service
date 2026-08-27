# payouts (placeholder — M3)

Payout requests and their state machine (`pending → processing → paid | failed`), driven by
a worker calling a **mock provider**. Idempotency-key required on create. No implementation in M1.
