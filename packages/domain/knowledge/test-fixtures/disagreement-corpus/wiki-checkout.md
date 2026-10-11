# Checkout payment retries

When the payment provider times out, checkout retries the authorization up to 5 times
with exponential backoff before failing the order.
