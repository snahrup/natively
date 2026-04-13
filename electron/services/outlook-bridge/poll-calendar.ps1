# poll-calendar.ps1 — Read calendar events within a date range
param(
    [string]$StartDate = "",
    [string]$EndDate = "",
    [int]$MaxItems = 100,
    [string]$OutputPath = ""
)

$ErrorActionPreference = 'Stop'

function Convert-ToSafeJsonText {
    param(
        [AllowNull()]
        [object]$Value,
        [int]$MaxLength = 0
    )

    if ($null -eq $Value) { return "" }

    $text = [string]$Value
    if ($MaxLength -gt 0 -and $text.Length -gt $MaxLength) {
        $text = $text.Substring(0, $MaxLength)
    }

    $text = $text -replace '"', "'"
    return ($text -replace "[`t`r`n]", " " -replace "\s{2,}", " ").Trim()
}

try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")
    $calendar = $namespace.GetDefaultFolder(9)  # olFolderCalendar
    $items = $calendar.Items
    $items.Sort("[Start]")
    $items.IncludeRecurrences = $true  # Expand recurring events

    # Default: today + 7 days
    if (-not $StartDate) { $StartDate = (Get-Date).ToString("MM/dd/yyyy") }
    if (-not $EndDate) { $EndDate = (Get-Date).AddDays(7).ToString("MM/dd/yyyy") }

    $startParsed = [DateTime]::Parse($StartDate)
    $endParsed = [DateTime]::Parse($EndDate)
    $filter = "[Start] >= '$($startParsed.ToString('MM/dd/yyyy'))' AND [Start] <= '$($endParsed.ToString('MM/dd/yyyy HH:mm'))'"
    $filtered = $items.Restrict($filter)

    $busyMap = @{ 0 = 'free'; 1 = 'tentative'; 2 = 'busy'; 3 = 'oof'; 4 = 'working-elsewhere' }
    $meetingMap = @{ 0 = 'non-meeting'; 1 = 'meeting'; 3 = 'received'; 5 = 'canceled' }
    $responseMap = @{ 0 = 'none'; 1 = 'organized'; 2 = 'tentative'; 3 = 'accepted'; 4 = 'declined' }

    $events = @()
    $count = 0

    foreach ($item in $filtered) {
        if ($count -ge $MaxItems) { break }
        if ($item.Class -ne 26) { continue }  # olAppointment

        $attendees = @()
        try {
            foreach ($recip in $item.Recipients) {
                $attendees += @{
                    name           = Convert-ToSafeJsonText $recip.Name
                    email          = Convert-ToSafeJsonText $recip.Address
                    type           = if ($recip.Type -eq 1) { "required" } else { "optional" }
                    responseStatus = $responseMap[[int]$recip.MeetingResponseStatus]
                }
            }
        } catch { }

        $event = @{
            entryId        = $item.EntryID
            subject        = Convert-ToSafeJsonText $item.Subject
            start          = $item.Start.ToString("o")
            end            = $item.End.ToString("o")
            duration       = $item.Duration
            location       = Convert-ToSafeJsonText $item.Location
            body           = Convert-ToSafeJsonText $item.Body 2000
            organizer      = Convert-ToSafeJsonText $item.Organizer
            busyStatus     = $busyMap[[int]$item.BusyStatus]
            isRecurring    = $item.IsRecurring
            allDayEvent    = $item.AllDayEvent
            meetingStatus  = $meetingMap[[int]$item.MeetingStatus]
            responseStatus = $responseMap[[int]$item.ResponseStatus]
            attendees      = $attendees
            categories     = if ($item.Categories) { ($item.Categories -split ',\s*' | ForEach-Object { Convert-ToSafeJsonText $_ }) } else { @() }
            reminder       = $item.ReminderMinutesBeforeStart
        }

        $events += $event
        $count++

        try { [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null } catch { }
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($filtered) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($items) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($calendar) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    $json = @{ events = $events } | ConvertTo-Json -Depth 10 -Compress
    if ($OutputPath) {
        [System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
        @{ outputPath = $OutputPath } | ConvertTo-Json -Depth 3 -Compress
    } else {
        $json
    }
} catch {
    @{ error = $_.Exception.Message; events = @() } | ConvertTo-Json -Depth 5 -Compress
}
