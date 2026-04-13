# check-availability.ps1 — Check free/busy for one or more contacts
param(
    [string]$Emails = "",          # Comma-separated email addresses
    [string]$StartDate = "",
    [int]$Days = 3,
    [int]$SlotMinutes = 30,
    [int]$BusinessStart = 9,
    [int]$BusinessEnd = 17
)

$ErrorActionPreference = 'Stop'

try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")

    if (-not $StartDate) { $StartDate = (Get-Date).ToString("yyyy-MM-dd") }
    $start = [DateTime]::Parse($StartDate)
    $emailList = $Emails -split ','

    $statusMap = @{ '0' = 'free'; '1' = 'tentative'; '2' = 'busy'; '3' = 'oof' }
    $slotsPerHour = 60 / $SlotMinutes
    $slotsPerDay = 24 * $slotsPerHour

    $results = @()

    foreach ($email in $emailList) {
        $email = $email.Trim()
        if (-not $email) { continue }

        $recipient = $namespace.CreateRecipient($email)
        $recipient.Resolve()

        $freeSlots = @()
        $busySlots = @()
        $contactName = $recipient.Name

        try {
            $freeBusy = $recipient.FreeBusy($start, $SlotMinutes, $true)

            for ($day = 0; $day -lt $Days; $day++) {
                $dayStart = $day * $slotsPerDay
                $bStart = $dayStart + ($BusinessStart * $slotsPerHour)
                $bEnd = $dayStart + ($BusinessEnd * $slotsPerHour)

                for ($slot = $bStart; $slot -lt $bEnd; $slot++) {
                    if ($slot -ge $freeBusy.Length) { break }
                    $char = $freeBusy[$slot].ToString()
                    $slotTime = $start.AddMinutes($slot * $SlotMinutes)
                    $slotEnd = $slotTime.AddMinutes($SlotMinutes)
                    $status = if ($statusMap.ContainsKey($char)) { $statusMap[$char] } else { 'free' }

                    $slotObj = @{
                        start  = $slotTime.ToString("o")
                        end    = $slotEnd.ToString("o")
                        status = $status
                    }

                    if ($status -eq 'free') {
                        $freeSlots += $slotObj
                    } else {
                        $busySlots += $slotObj
                    }
                }
            }
        } catch {
            # FreeBusy may fail for external contacts
        }

        # Merge consecutive same-status slots
        function Merge-Slots($slots) {
            if ($slots.Count -eq 0) { return @() }
            $merged = @()
            $current = $slots[0].Clone()
            for ($i = 1; $i -lt $slots.Count; $i++) {
                if ($slots[$i].start -eq $current.end -and $slots[$i].status -eq $current.status) {
                    $current.end = $slots[$i].end
                } else {
                    $merged += $current
                    $current = $slots[$i].Clone()
                }
            }
            $merged += $current
            return $merged
        }

        $results += @{
            contact    = @{ name = $contactName; email = $email }
            dateRange  = @{ start = $start.ToString("yyyy-MM-dd"); end = $start.AddDays($Days).ToString("yyyy-MM-dd") }
            slotDuration = $SlotMinutes
            freeSlots  = Merge-Slots $freeSlots
            busySlots  = Merge-Slots $busySlots
        }

        [Runtime.InteropServices.Marshal]::ReleaseComObject($recipient) | Out-Null
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    @{ results = $results } | ConvertTo-Json -Depth 10 -Compress
} catch {
    @{ error = $_.Exception.Message; results = @() } | ConvertTo-Json -Depth 5 -Compress
}
