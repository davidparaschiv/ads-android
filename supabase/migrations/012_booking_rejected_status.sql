-- PostgreSQL requires a new enum value to be committed before functions can use it.
-- Keep this migration separate from the booking approval implementation in 013.
alter type public.booking_status add value if not exists 'rejected';
