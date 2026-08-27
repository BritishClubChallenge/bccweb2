# British Club Challenge

An inter-club paragliding cross-country league. Clubs field teams of pilots at a series of
competition days; pilots fly, submit tracklogs, and are scored into a season-long league table.
This glossary is the shared vocabulary for the whole system — API, SPA and shared packages.

## Competition structure

**Season**:
One calendar year of the competition, holding its rounds and its league table.
_Avoid_: year, campaign

**Round**:
A single competition day at one site, run by an organising club. The unit that pilots register
for, fly, and are scored on.
_Avoid_: event, comp, competition day, task

**Site**:
A flying site a round can be held at, with its parking, briefing and take-off locations.
_Avoid_: venue, location, hill

**Club**:
A BHPA club whose pilots and teams take part in the competition.
_Avoid_: organisation

**Active Season**:
The one season currently being competed. Exactly one at a time; past seasons are closed to
change.
_Avoid_: current season, open season

**Season Club**:
A club's participation in one season: how many teams it may field, and its acceptance of the
season's terms. A club that has not entered a season has no Season Club for it.
_Avoid_: club entry, club registration

**Organising Club**:
The club running a round — responsible for the brief, the roster and the day.
_Avoid_: host club, home club

**Guest Organiser**:
An organising club running a round at a site owned by a different club.
_Avoid_: visiting club

**Club Team**:
A named team belonging to a club — "TVHGC A", "TVHGC B". A child of its club, fielded across a
season. Holds no slots, pilots or scores of its own.
_Avoid_: squad, standing team

**League Table**:
The season standings, ranking each team by its counted round scores.
_Avoid_: leaderboard, standings

## People

**Pilot**:
A person who competes: their rating, wing, safety details and club history. Exists whether or
not anyone has ever logged in as them.
_Avoid_: member, competitor, entrant

**User**:
An authentication account with an email and roles. A User may be linked to a Pilot, or to none.
_Avoid_: account, login

**Rounds Coordinator**:
A role that may create and run rounds, scoped to a single club. Cannot act on other clubs' rounds.
_Avoid_: organiser, coord (in prose; `RoundsCoord` is the role's name)

**Captain**:
The pilot leading one team on the day of one round. Transient: a captaincy means nothing
outside its round, and carries across neither seasons nor rounds.
_Avoid_: team lead

**Organiser**:
The person accountable for a round on the day — that it runs, that it runs safely, and that
everything it requires has happened. Accountable rather than hands-on: the brief may be
delivered by someone else, and the Organiser is the one who ensures it was.
_Avoid_: manager, round manager, controller

**Briefer**:
The person who delivers the safety brief on the day, recorded on the round brief with their
coaching qualification. May or may not be the Organiser.
_Avoid_: safety officer

## Round day

**Team**:
A club's team in one round: its slots, its captain for the day, and its score. Takes its name
from a Club Team but is distinct from it — a Club Team that skips a round has no Team there.
_Avoid_: squad, entry

**Slot**:
A numbered place in a team for one round. Either empty, or filled by one pilot. Slots persist
across roster changes; their occupant may change.
_Avoid_: seat, position, entry

**Occupancy**:
One pilot's tenure of one slot. The unit sign-to-fly attaches to: a pilot who leaves a slot and
later returns to it still holds their own signature, and never inherits the signature of
whoever held the slot in between.
_Avoid_: assignment, tenure, slot-pilot pair

**Place in Team**:
A slot's number within its team. Identifies the slot; not a ranking.
_Avoid_: index, position

**Scoring Slot**:
A slot whose pilot's points count toward the team score. Non-scoring slots fly and are briefed
but contribute nothing.
_Avoid_: counting slot

**No Result**:
A filled slot that posted nothing to score — the pilot did not fly, or flew and recorded no
distance. Orthogonal to whether the slot is a Scoring Slot: a Scoring Slot can end with No
Result, and a non-scoring slot can fly well.
_Avoid_: no score, DNF, zero

**Roster**:
The set of filled slots across a round's teams — who is flying.
_Avoid_: lineup, entry list

**Registration**:
Getting a pilot onto a round's roster: declaring Availability, then Placement. Open only while
the round is Proposed or Confirmed.
_Avoid_: entry, signup, booking

**Availability**:
A pilot declaring they intend to fly a round. Says nothing about a slot — a pilot may be
available for a round and never placed in it, and being available costs them nothing.
_Avoid_: interest, intent, signup (and note it describes a pilot, never a free slot)

**Placement**:
Putting an available pilot into a slot — by their club's coordinator, or by the pilot
themselves where self-service is open. Only a placed pilot flies.
_Avoid_: assignment, allocation, selection

**Double Booking**:
One pilot holding slots in two rounds on the same day. Prohibited — a pilot flies at most one
round a day.
_Avoid_: clash, conflict, overlap

**Minimum Score**:
The shortest flight a round will accept as a result. Also the bar that decides how many
flights count toward the round's difficulty factor.
_Avoid_: minimum distance, threshold, cut-off

**Event Frequency**:
The radio frequency for the round as a whole — the organiser's channel, carrying event-wide
calls and emergencies. Every pilot on the hill needs it, so it is briefed to all of them, and
changing it invalidates their signatures.
_Avoid_: frequency (unqualified), day frequency, round frequency

**Club Frequency**:
A club's own working channel, shared by all of its teams. Allocated to the club for a season
rather than chosen by it, and spaced so that clubs flying the same day do not tread on each
other or on the Event Frequency. Not briefed to anyone outside the club.
_Avoid_: frequency (unqualified), team frequency, private channel

**Snapshot**:
A pilot's safety and equipment details as they stood when the round locked — wing, rating,
emergency contact, medical notes. Frozen so the brief and the day's paperwork cannot shift
under the people relying on them.
_Avoid_: freeze, copy, cached pilot

**Accounted For**:
A record that a slot's occupant has been confirmed present and safe after flying. Attaches to
the Slot, not the Occupancy: a filled slot whose pilot is unidentified still has a body to
account for, even though nobody can have signed for it. Independent of whether they scored.
_Avoid_: checked in, signed off, present

**Flight**:
One pilot's flight in one round: its distance, duration and score.
_Avoid_: track, log, task

**Tracklog**:
The IGC file evidencing a flight, from which distance is solved.
_Avoid_: trace, GPS file

**Manual Log**:
A flight recorded without a tracklog, on a coordinator's justification.
_Avoid_: manual entry, override flight

## Round lifecycle

The states a round moves through. Each name below is the state's exact name. Proposed and
Confirmed happen in the weeks beforehand; BriefComplete, Locked and Complete all happen on the
day of the round, on the hill.

**Proposed**: created, open for registration, nothing fixed.
**Confirmed**: going ahead; still open for registration. Pilots plan and travel around this.
**BriefComplete**: the brief has been delivered on the hill and frozen, and pilots may now sign
to fly. The roster is frozen from here on.
**Locked**: the roster is snapshotted and the round is being flown.
**Complete**: flown and scored, with the season league recomputed. The Fixture is settled; the
record stays open to Admin correction.
**Cancelled**: called off. May be reopened as Proposed.

**Roster Frozen**:
The condition, from BriefComplete onward, in which teams and slots may no longer be changed.
_Avoid_: locked (which names one specific state)

**Fixture**:
When a round is held, where, who hosts it, and how many teams it has room for. Fixed from the
moment the brief is delivered — by then everyone is standing on the hill. A round arranged
wrongly is spotted well beforehand and is cancelled and re-scheduled, never re-pointed.
_Avoid_: setup, details, metadata

**Correction**:
An Admin's fix to a flown round's record — a misattributed flight, a wrong distance, a mis-set
minimum score. Changes the result, never the Fixture, and is followed by a rescore so the
league keeps up.
_Avoid_: edit, amendment, adjustment

## Brief and sign-to-fly

**Round Brief**:
The safety briefing document for a round: conditions, hazards, airspace, timings, and the
roster as briefed. What pilots sign against.
_Avoid_: briefing notes, safety notice

**Brief Version**:
A numbered revision of a round brief. Editing material content raises the version and
invalidates signatures made against the old one.
_Avoid_: revision, edition

**Brief Publication**:
The record of a round brief being issued: which version is current, and whether its printable
form is ready to hand out. Distinct from the Round Brief, which is the content itself.
_Avoid_: brief pointer, brief metadata

**Material**:
Of a brief change: one that alters the safety picture a pilot agreed to — timings, wind,
airspace, hazards, landing area, locations — and therefore invalidates their signature.
Correcting who the briefer was is not material and leaves signatures standing.
_Avoid_: significant, breaking, substantive

**Sign-to-Fly**:
A pilot's confirmation that they have read and accepted the current brief. Attaches to an
Occupancy, not to a slot. Required for every filled slot before a round may lock.
_Avoid_: sign off, acceptance, waiver

**Signature**:
One immutable record that a pilot signed a specific brief version for one Occupancy, with the
wording they saw and when. Never edited or deleted; superseded only by a later signature for
the same Occupancy.
_Avoid_: sign-off record, consent

**Signature Ledger**:
The append-only collection of a round's signatures. The authority on who has signed what.
_Avoid_: signature store, consent log

**Wording**:
The versioned text a pilot agrees to when signing. Recorded on each signature so it is always
knowable what was actually agreed.
_Avoid_: terms, declaration, copy

**Override**:
A coordinator signing to fly on a pilot's behalf, with a recorded reason. Distinct from a
pilot's own signature and audited separately.
_Avoid_: manual sign, force sign

## Scoring

**Pilot Points**:
A pilot's normalised score for a round, after their rating and wing class are applied.
_Avoid_: pilot score (which is the raw pre-normalisation figure)

**Team Score**:
A team's normalised round score, from its top-scoring pilots only.
_Avoid_: team points

**Wing Class**:
The certification band of a pilot's glider, which sets their wing factor.
_Avoid_: glider class, EN rating

**Pilot Rating**:
A pilot's competition rating, which sets their pilot factor.
_Avoid_: skill level, grade

**Factor**:
A multiplier applied when scoring — by wing class, pilot rating, clubs attending, or the count
of flights over the minimum distance. Factors handicap the competition.
_Avoid_: weighting, modifier

**Normalisation**:
Scaling raw scores so the best performance in a round sets the ceiling, making rounds
comparable across sites and conditions.
_Avoid_: scaling, weighting

**Rescore**:
Recalculating one round's scores, on request, after its flights or the scoring configuration
change.
_Avoid_: rerun, recalculate

**Recompute**:
Rebuilding a season's derived standings after one of its rounds changes.
_Avoid_: refresh, rebuild

## Prizes and awards

**Prize**:
A one-off achievement recognised on a flight: a pilot's first cross-country, their first in
the UK, a UK personal best, or an overall personal best. First XC and First UK XC can each be
won once per pilot, ever.
_Avoid_: achievement, badge, honour

**Awarded**:
Whether a prize has actually been handed over to the pilot. Tracked separately from winning
it, and reversible.
_Avoid_: claimed, delivered, presented

**Spirit of BCC**:
A season award decided by nomination rather than by score, recognising contribution to the
competition rather than flying performance.
_Avoid_: sportsmanship award

## External services

**PureTrack**:
The third-party live-tracking service. A round and each of its teams get a PureTrack group so
the day can be followed live.
_Avoid_: tracker, live tracking (as a proper noun)

**FAI Validation**:
The external check that a tracklog's digital signature and date are genuine.
_Avoid_: vali, verification

**BHPA**:
The British Hang Gliding and Paragliding Association. Pilots carry a BHPA number, and coaching
qualifications are BHPA grades.
