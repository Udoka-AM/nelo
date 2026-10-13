# Investor materials

| File | What |
|---|---|
| `nelo-deck-10.pptx` | The investor deck (Montserrat, dark aurora). The live, edited copy is kept in Google Slides |
| `nelo-deck.pptx` | The earlier long-form deck, in the site's brand |
| `index.html` | A browser deck: one self-contained file, no build and no server |
| `growth-model.py` | The three-year model behind the Market and Projection slides; every input is stated |
| `video-script.md` | The product film: script, shot list and rules |
| `BRIEF.md` | The brief for rebuilding the deck |

## Presenting `index.html`

| Key | Action |
|-----|--------|
| `→` `Space` `Enter` | Next slide |
| `←` | Previous slide |
| `Home` / `End` | First / last slide |
| `O` | Overview grid — jump to any slide |
| `F` | Fullscreen |

Swipe left and right works on a touchscreen. Deep-link a slide with `#7`.

## Keeping the numbers honest

Every figure in the deck comes from [`../BUILD.md`](../BUILD.md) or `growth-model.py`. Change an
assumption in the model, re-run it (`python3 docs/deck/growth-model.py`), and update the deck
and the film script from its output, never the other way round.
