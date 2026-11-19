; SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
; SPDX-License-Identifier: MIT

; Assisted installers otherwise offer an all-users installation too. Keep the
; existing per-user scope and skip that extra page (decision 0007).
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
