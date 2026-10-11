---
feature: checkout
component: checkout-api
expected_behaviors:
  - id: checkout-002
    description: a payment authorization is retried at most max_payment_retries times
constraints:
  max_payment_retries: { type: int, value: 4 }
---

## Checkout

Adopted expectation: checkout SHOULD retry a payment authorization at most 4 times. The value is
deliberately distinct from the wiki (5) and from the code and traces (3), so a "how many should
it" answer taken from the wrong source is detectable.
