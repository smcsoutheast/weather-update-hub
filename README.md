# SMC Southeast Weather Hub, Single Command Device Build

This build keeps the existing public design and Command Center, but replaces the operational data flow with a single-writer model.

## Core design

- One computer or tablet owns the Command Center.
- Only the active Command Device publishes operational changes.
- Other admin devices open in read-only mode until staff select Take Over Command Center.
- Public viewers never write operational data.
- Firebase is the published source of truth.
- Operational data is not stored in LocalStorage.
- LocalStorage stores only a browser device ID used for Command Device ownership.
- Public viewers use lightweight Firebase REST polling instead of a persistent Realtime Database listener.
- The public page keeps the last valid published status if a refresh fails.
- A failed connection never changes a venue to Green.

## Active weekend venue model

Tournament assignment has been removed from venues.

Every venue stored in the Hub is treated as active and appears publicly.

For each tournament weekend:

1. Open the Command Center on the designated SMC computer or tablet.
2. Remove old venues or select Clear Weekend Hub.
3. Add only venues being used for the current weekend.
4. Publish venue, field, lightning, and public note updates from the Command Device.

There is no tournament selector, current-tournament selector, or public tournament visibility filter.

## Lightning model

Each venue has one lightning record.

A new qualifying strike updates the same venue lightning record. It does not create a second competing timer.

Rules used by this build:

- 10 miles or less starts or resets the 30-minute venue timer and sets the venue Red.
- More than 10 miles through 15 miles creates Yellow monitoring when no Red timer is already active.
- A new strike at another venue does not alter any other venue timer.
- Reaching 00:00 does not change the venue to Green.
- At 00:00 the public display says the clearance period is complete and SMC All Clear is still required.
- Manual All Clear is required to remove a lightning-related venue status and authorize a return to play.
- Manual All Clear only changes the selected venue.

## Public traffic model

Public viewers read only the `public` branch from Firebase.

The public page polls Firebase every 30 seconds during normal operations and every 10 seconds when an active weather status exists.

This removes the persistent Realtime Database listener used by each public browser in the previous build.

The Command Device still uses the Firebase SDK for operational writes and Command Device ownership.

## Firebase data location

This build uses a new clean database branch:

`southeast-weather-hub-v2`

The previous Hub data branch is not loaded. This prevents stale legacy browser or database data from resetting the new Hub.

Structure:

```text
southeast-weather-hub-v2
  public
    globalNote
    updatedAt
    venues
      venue-id
        name
        state
        status
        statusSource
        note
        fields
        lightning
    history
  admin
    timeline
    incidents
  system
    commandDevice
```

## Firebase configuration

`firebase-config.js` is already configured for the `southeast-weather-hub` Firebase project supplied for this Hub.

## Firebase Realtime Database rules

For the current front-end password build, publish the rules in `FIREBASE-RULES.json`.

These rules allow public reads and allow the web application to publish updates. Command Device ownership is enforced by the application logic, not by Firebase Authentication.

For stronger security, the next upgrade should add Firebase Authentication and restrict writes to approved SMC accounts.

## Command Center access

Click the shield icon.

Tournament Director, Justin

Password: `justin2026$`

Tournament Operations, Ashley

Password: `ashley2026$`

The first authenticated device with no active Command Device lock claims control automatically.

If another device owns control, the Command Center opens read only and shows Take Over Command Center.

## Command Device behavior

The active device writes a heartbeat to Firebase every 10 seconds.

A Command Device lock is treated as stale after 45 seconds without a heartbeat.

Refreshing the same Command Device keeps the same browser device ID and restores ownership.

Closing the device without releasing control lets the lock expire. A backup device then claims control or uses Take Over Command Center.

## Weekend setup

1. Upload all files in this folder to the root of the GitHub repository.
2. Publish `FIREBASE-RULES.json` in Firebase Realtime Database Rules.
3. Wait for GitHub Pages to deploy.
4. Open the public Hub and verify the connection message is green.
5. Open Admin Access on the designated SMC computer or tablet.
6. Verify Firebase shows Synced and the device shows Active Command Device.
7. Select Clear Weekend Hub if old Version 2 weekend data exists.
8. Add only the venues being used for the weekend.
9. Test one Green, Yellow, and Red venue update.
10. Test two lightning delays at two different venues.
11. Confirm one venue timer does not affect the other.
12. Open the public Hub on several phones and confirm none of those views changes the Command Device data.

## Recommended operating procedure

Keep the designated Command Device connected to power.

Use one reliable internet connection with a backup hotspot available.

Do not use Take Over Command Center unless the primary device is unavailable or staff intentionally transfer control.

When a lightning clearance period reaches 00:00, verify field and weather conditions, then select Manual All Clear for that venue.

## Files

- `index.html`
- `style.css`
- `script.js`
- `firebase-config.js`
- `FIREBASE-RULES.json`
- `GITHUB-PAGES-DEPLOYMENT-CHECKLIST.md`
- `.nojekyll`
- `assets/smc-logo.png`
- `assets/my-lightning-tracker.webp`
- `assets/myradar.webp`


## Public View Reliability Update

This build hides normal Firebase connection messages from public visitors. A connection notice appears only when the Hub cannot refresh current data.

Image assets use relative GitHub Pages paths and include browser-side fallbacks. If an app logo or SMC logo fails to load, the page displays a text fallback instead of a broken-image icon.

Asset files must remain in:

- `assets/smc-logo.png`
- `assets/my-lightning-tracker.webp`
- `assets/myradar.webp`



## Manual All Clear reliability update

- Manual All Clear remains visible whenever a venue has an uncleared lightning condition.
- Editing venue details no longer removes lightning control from an active venue.
- Global status changes no longer hide Manual All Clear for an active lightning venue.
- Weather Update Builder messages preserve lightning control while the lightning condition remains uncleared.
- Manual All Clear restores the venue state recorded before the lightning delay.
