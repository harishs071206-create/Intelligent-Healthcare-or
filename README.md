# OT-Scheduling

Operating theatre scheduling with constraint checking, an optimizer, a live board,
and emergency recalculation that minimises disruption to the existing list.

```
pip install -r requirements.txt
python app.py          # http://127.0.0.1:5000
```

The database is created and seeded from `data/sample_data.json` on first run.
"Reload the sample day" on the requests page rebuilds it.

## Layout

```
OT-Scheduling/
├── app.py                  Flask routes, SQLite bootstrap, JSON API
├── scheduler/optimizer.py  constraints, slot search, emergency preemption
├── templates/
│   ├── index.html          surgery request intake + today's request list
│   └── dashboard.html      theatre board, emergency form, waitlist, log
├── static/
│   ├── style.css
│   └── script.js           renders the board, drives the emergency flow
├── database/schema.sql     surgeon, theatre, equipment, surgery_request
├── data/sample_data.json   seed: 4 theatres, 4 surgeons, 5 equipment, 9 cases
└── requirements.txt
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | request intake form and today's submitted requests |
| `POST /request` | add a surgery request |
| `GET /dashboard` | the theatre board |
| `GET /api/schedule` | build and return the full day as JSON |
| `POST /api/emergency` | insert an emergency case, return the new schedule + what moved |
| `POST /reset` | drop and reseed the database |

## Constraints checked

Run in the order of the flowchart, in `Scheduler.check()`:

1. **Surgeon** — free, inside shift, under the duty-hour cap
2. **OT** — correct type, free including the turnover time held after the previous case
3. **Equipment** — a mobile unit free; equipment fixed in the theatre consumes no unit
4. **Existing schedule** — patient ready time, clinical deadline, end of the operating day

`check()` returns the list of *reasons* a slot fails rather than a boolean, which is what
lets the waitlist say why a case could not be placed.

## Optimization

Cases are ranked `(priority, deadline, -duration)` and each is placed in its earliest
feasible slot. Candidate start times are restricted to moments when some resource frees
up, so the search is event-driven instead of scanning minute by minute.

## Emergency recalculation

`handle_emergency(req, max_wait=45)`:

1. Try a free slot inside the safe window. If one exists, nothing moves.
2. Otherwise cancel elective cases one at a time — latest-starting and shortest first,
   and only in theatres the emergency could actually use — retrying after each one, so the
   number of displaced patients is as small as possible.
3. Rebook everything that was displaced; anything that no longer fits goes to the waitlist
   with a reason.
4. If even preemption fails, flag the case for transfer to another facility.

The response includes a `delta` with the ids that moved. The board flashes exactly those
bars amber so the coordinator can see what changed.

On the sample day the emergency lands in Theatre 3 at 12:05 and displaces a single hernia
repair, which rebooks into Theatre 4 at 13:50. Disruption: one case.

## Extending

- Replace the greedy placer with OR-Tools CP-SAT; `check()` documents exactly which
  constraints to encode.
- Add a `schedule` table so a published list survives a restart instead of being rebuilt
  on each request.
- Weight the objective for overtime cost or surgeon idle time inside `_rank` / `find_slot`.
