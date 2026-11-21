# Review Deck

This page is a reference, not a chapter: there is no quiz and nothing to read in
order. It is a deck of practice problems on the calculations the course keeps
coming back to — bytes per token, decode floors, step times, Little's law, the
memory budget, speculative yield, cost per million tokens — and it is meant to be
opened for ten minutes every few days, long after the chapters themselves.

## Why the numbers change every time

Most flashcard decks ask the same question every time, and after a few rounds you
are recalling an answer rather than working it out. That holds until the problem
arrives in a different shape: another model, another GPU, a longer context.
So no card here has a fixed answer. Each card is a small generator: every time it
is dealt it picks a new model shape, context length, chip or price sheet from
realistic ranges, and asks for one number. You type the number; the deck checks
it against a tolerance (usually 10% — this is back-of-envelope arithmetic, not
accounting) and then shows the worked solution with *those* inputs, plus a link to
the chapter that teaches the formula.

Two habits make it work. Commit to a number before you check, even a rough one:
retrieving a method and getting it wrong teaches more than reading the answer.
And read the solution when you were right, too — the last line of each one is the
point the chapter was making.

## How the schedule works

The deck uses five boxes, the scheme Sebastian Leitner described in 1972. A card
you have never seen starts in box 1. Answer it within tolerance and it moves up a
box; miss it and it goes back to box 1, due again tomorrow.

| Box | Comes back after |
|---|---|
| 1 | 1 day |
| 2 | 3 days |
| 3 | 7 days |
| 4 | 16 days |
| 5 | 35 days |

The gaps widen because each successful recall from further away makes the memory
more durable — spacing reviews out works better than cramming them together.
A card only joins the deck once you have completed the chapter that teaches it,
so the deck grows as you read. The box below lets you include the rest early.

When nothing is due, "Practise anyway" deals extra cards: a right answer there
leaves the schedule alone, a miss sends the card back to box 1. Chapters you
read later also open with a short, collapsed warm-up of up to three due cards
from earlier chapters. Your schedule is kept in this browser only, next to your
chapter progress.

## Your deck

<div class="inf-widget" data-widget="review" data-mode="deck">
<p class="inf-widget-fallback">The review deck needs JavaScript. Without it, the exercises at the end of each chapter are the closest substitute: cover the answer, work the number, then check.</p>
</div>
