# GitHub Pages Deployment Checklist

1. Back up the current GitHub repository before replacing files.
2. Upload the contents of this folder directly to the repository root.
3. Confirm `index.html` is in the repository root.
4. Confirm `firebase-config.js` is in the repository root.
5. Confirm the `assets` folder is in the repository root.
6. In Firebase Console, open Realtime Database, then Rules.
7. Replace the current test rules with the contents of `FIREBASE-RULES.json` and publish.
8. In GitHub, open Settings, then Pages.
9. Set the source to Deploy from branch, main, root.
10. Wait for deployment to finish.
11. Open the public page in a private browser window.
12. Confirm the page says the live status feed is connected.
13. Open Admin Access on the designated Command Device.
14. Confirm Firebase says Synced.
15. Confirm the device says ACTIVE COMMAND DEVICE.
16. Add one test venue.
17. Open the public page on a second device and confirm the venue appears.
18. Start a test lightning delay at the first venue.
19. Add a second venue and start a separate lightning delay.
20. Confirm each venue keeps its own timer.
21. Confirm a timer reaching 00:00 stays Red and says Awaiting SMC All Clear.
22. Select Manual All Clear for one venue and confirm only that venue changes to Green.
23. Open Admin Access on another device and confirm it opens read only.
24. Test Take Over Command Center only after the first device is ready to lose write control.
