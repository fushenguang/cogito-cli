/**
 * Design-resolution size — the single source of truth.
 *
 * Phaser's Scale Manager (see `config.ts`) fits and centers this virtual
 * resolution into whatever space the browser gives it. Write all
 * gameplay/layout code against these constants, never against
 * `window.innerWidth/innerHeight`.
 *
 * 🔴 **HUD band / playfield contract — real bug, not a hypothetical.** A
 * generated game once drew its HUD and its world geometry in the same
 * scene with no notion of a reserved HUD area: the word-list button row
 * (`y ∈ [502, 530]`) and the full-width ground (`y ∈ [508, 540]`) landed on
 * top of each other, a deterministic 22px overlap a screenshot review
 * missed. The fix is structural, not "look harder": this module reserves a
 * horizontal band along the bottom `HUD_BAND_HEIGHT` pixels tall for HUD
 * content, and `PLAYFIELD_HEIGHT` is what's left for world geometry.
 *
 *   - World geometry (ground, platforms, spawn points, physics world
 *     bounds, anything gameplay) MUST stay within `y ∈ [0, PLAYFIELD_HEIGHT]`.
 *   - HUD content (score, buttons, status text) MUST stay within the band
 *     `y ∈ [PLAYFIELD_HEIGHT, GAME_HEIGHT]`, and belongs in a dedicated UI
 *     Scene running parallel to the gameplay scene (`setScrollFactor(0)`),
 *     never inside the gameplay scene itself — see `scenes/UiScene.ts`.
 *   - The two ranges are disjoint by construction (`PLAYFIELD_HEIGHT =
 *     GAME_HEIGHT - HUD_BAND_HEIGHT`); do not carve HUD space out of the
 *     playfield ad hoc elsewhere.
 *
 * 🔴 **Why this lives in its own module, with no imports at all.**
 *
 * Two very different consumers need these numbers:
 *
 *   - `config.ts` — pulls in Phaser and every scene class. Browser only.
 *   - `debug/state-jump.ts` — the state-jump contract, which must stay
 *     importable by a bare Node process so `tests/state-jump.test.mjs`
 *     can run without a DOM or WebGL.
 *
 * If the constants lived in `config.ts`, the contract would have to either
 * drag Phaser into Node (it does not run there) or keep a hand-copied
 * duplicate. The duplicate was the first attempt, and it is exactly the
 * "same fact stored twice, drifts later" shape this template's other
 * comments keep warning about: nothing would fail if someone changed the
 * design resolution in one place only — the traversal assertion would keep
 * passing while asserting against stale bounds.
 *
 * A leaf module with zero imports serves both without either problem.
 * **Keep it import-free.** Adding any import here can re-break Node
 * importability for the contract and its tests.
 */
export const GAME_WIDTH = 960
export const GAME_HEIGHT = 540

/** Height, in pixels, of the bottom band reserved for HUD content. See the contract above. */
export const HUD_BAND_HEIGHT = 64

/** Vertical space available to world geometry — everything gameplay draws must stay within `[0, PLAYFIELD_HEIGHT]`. */
export const PLAYFIELD_HEIGHT = GAME_HEIGHT - HUD_BAND_HEIGHT
