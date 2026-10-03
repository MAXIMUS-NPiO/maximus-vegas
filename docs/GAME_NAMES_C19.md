# Game names C-19
Owner request, 3 October 2026: games with a saved name disappear from the new-game list; another name for an existing game is a separate mode and game selector; after all games are filled only that mode remains.
Applies to onboarding and settings, RU/EN. Existing names remain intact. A removal targets one name; removing the last name returns the game to the new-game list. Public profile and export include all names; account erasure removes them.
Migration 25 is additive and preserves the original account table and unique key.
Verification: targeted database tests PASS; RU/EN browser scenario PASS (all game names, extra name, removal, reservation, registration and voluntary team acceptance). Publication pending required CI.
