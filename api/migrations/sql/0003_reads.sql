-- The shape of a cash session, for this server's own reads.
--
-- private.session_json is what open_session and register_terminal already answer a session with, and
-- GET /cash-sessions has to answer the same shape. The other reads build their JSON in the query that
-- makes them, but a shape that two places must agree on is better kept in one, so this server calls
-- the function the café model already has instead of writing it out again.
--
-- Safe to hand to cafe_app although it is security definer: it maps a row it is given to JSON and
-- reads nothing else but that row's terminal code, so a member sees the sessions the policies have
-- already shown them and no others.

grant execute on function private.session_json(public.cash_sessions) to cafe_app;
