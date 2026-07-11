## 1. Burden Meter Layout

- [x] 1.1 Restructure the review-burden meter so the headline and level share a stable first row with the numeric score and the precise anchor occupies a dedicated second row.
- [x] 1.2 Update the burden-meter styles so long anchors wrap within the available width without horizontal overflow while short anchors remain fully visible.

## 2. Regression Coverage

- [x] 2.1 Add an E2E fixture case with a deliberately long configured base ref and a narrow sidebar.
- [x] 2.2 Assert the meter contains the complete anchor, keeps the headline, level, and score visible, and stays within its horizontal bounds.
- [x] 2.3 Run the focused Change Overview E2E coverage and relevant validation checks.
