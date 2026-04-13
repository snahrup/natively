# execute-action.ps1 — Execute outbound Outlook actions from JSON input
# Reads JSON from stdin (piped) or -JsonInput parameter
param(
    [string]$JsonInput = ""
)

$ErrorActionPreference = 'Stop'

# Read from stdin if no parameter
if (-not $JsonInput) {
    $JsonInput = [Console]::In.ReadToEnd()
}

try {
    $task = $JsonInput | ConvertFrom-Json
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")

    $result = @{ success = $false; action = $task.action; detail = "" }

    switch ($task.action) {
        # ── Email: Send new ──────────────────────────────────────
        "email_send" {
            $mail = $outlook.CreateItem(0)  # olMailItem
            $mail.Subject = $task.subject
            if ($task.htmlBody) {
                $mail.HTMLBody = $task.htmlBody
                $mail.BodyFormat = 2  # olFormatHTML
            } else {
                $mail.Body = $task.body
            }

            foreach ($to in $task.toRecipients) {
                $recip = $mail.Recipients.Add($to)
                $recip.Type = 1  # olTo
            }
            if ($task.ccRecipients) {
                foreach ($cc in $task.ccRecipients) {
                    $recip = $mail.Recipients.Add($cc)
                    $recip.Type = 2  # olCC
                }
            }
            if ($task.importance) {
                $impMap = @{ 'low' = 0; 'normal' = 1; 'high' = 2 }
                $mail.Importance = $impMap[$task.importance]
            }
            if ($task.attachments) {
                foreach ($att in $task.attachments) {
                    if (Test-Path $att) { $mail.Attachments.Add($att) | Out-Null }
                }
            }
            $mail.Recipients.ResolveAll() | Out-Null

            if ($task.send -eq $true) {
                $mail.Send()
                $result.detail = "Email sent to $($task.toRecipients -join ', ')"
            } else {
                $mail.Display()
                $result.detail = "Email draft opened for review"
            }
            $result.success = $true
        }

        # ── Email: Reply ─────────────────────────────────────────
        "email_reply" {
            $original = $namespace.GetItemFromID($task.originalEntryId)
            $reply = if ($task.replyAll) { $original.ReplyAll() } else { $original.Reply() }
            $reply.Body = $task.body + $reply.Body

            if ($task.send -eq $true) {
                $reply.Send()
                $result.detail = "Reply sent"
            } else {
                $reply.Display()
                $result.detail = "Reply draft opened for review"
            }
            $result.success = $true
            [Runtime.InteropServices.Marshal]::ReleaseComObject($original) | Out-Null
        }

        # ── Email: Forward ───────────────────────────────────────
        "email_forward" {
            $original = $namespace.GetItemFromID($task.originalEntryId)
            $fwd = $original.Forward()
            if ($task.body) { $fwd.Body = $task.body + $fwd.Body }
            foreach ($to in $task.forwardTo) {
                $recip = $fwd.Recipients.Add($to)
                $recip.Type = 1
            }
            $fwd.Recipients.ResolveAll() | Out-Null

            if ($task.send -eq $true) {
                $fwd.Send()
                $result.detail = "Forwarded to $($task.forwardTo -join ', ')"
            } else {
                $fwd.Display()
                $result.detail = "Forward draft opened for review"
            }
            $result.success = $true
            [Runtime.InteropServices.Marshal]::ReleaseComObject($original) | Out-Null
        }

        # ── Email: Mark read/unread ──────────────────────────────
        "email_mark_read" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            $item.UnRead = -not $task.isRead
            $item.Save()
            $result.success = $true
            $result.detail = "Marked as $(if ($task.isRead) {'read'} else {'unread'})"
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        # ── Email: Flag ──────────────────────────────────────────
        "email_flag" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            $item.FlagRequest = if ($task.flagText) { $task.flagText } else { "Follow up" }
            $item.Save()
            $result.success = $true
            $result.detail = "Flagged: $($item.FlagRequest)"
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        # ── Email: Categorize ────────────────────────────────────
        "email_categorize" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            $item.Categories = $task.categories -join ", "
            $item.Save()
            $result.success = $true
            $result.detail = "Categories set: $($item.Categories)"
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        # ── Email: Move to folder ────────────────────────────────
        "email_move" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            $targetFolder = $null
            # Try default folders first
            $folderMap = @{ 'inbox' = 6; 'deleted' = 3; 'drafts' = 16; 'sentitems' = 5; 'junk' = 23 }
            if ($folderMap.ContainsKey($task.targetFolder.ToLower())) {
                $targetFolder = $namespace.GetDefaultFolder($folderMap[$task.targetFolder.ToLower()])
            } else {
                # Try to find by name under inbox parent
                $inbox = $namespace.GetDefaultFolder(6)
                try { $targetFolder = $inbox.Folders.Item($task.targetFolder) } catch { }
                if (-not $targetFolder) {
                    $targetFolder = $inbox.Parent.Folders.Item($task.targetFolder)
                }
            }
            if ($targetFolder) {
                $item.Move($targetFolder) | Out-Null
                $result.success = $true
                $result.detail = "Moved to $($task.targetFolder)"
            } else {
                $result.detail = "Folder not found: $($task.targetFolder)"
            }
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        # ── Calendar: Create appointment/meeting ─────────────────
        "calendar_create" {
            $appt = $outlook.CreateItem(1)  # olAppointmentItem
            $appt.Subject = $task.subject
            $appt.Start = [DateTime]::Parse($task.start)
            $appt.End = [DateTime]::Parse($task.end)
            if ($task.location) { $appt.Location = $task.location }
            if ($task.body) { $appt.Body = $task.body }

            $busyMap = @{ 'free' = 0; 'tentative' = 1; 'busy' = 2; 'oof' = 3; 'working-elsewhere' = 4 }
            if ($task.busyStatus -and $busyMap.ContainsKey($task.busyStatus)) {
                $appt.BusyStatus = $busyMap[$task.busyStatus]
            }
            if ($task.reminder) { $appt.ReminderMinutesBeforeStart = $task.reminder }
            if ($task.categories) { $appt.Categories = $task.categories -join ", " }

            # Add attendees → makes it a meeting
            $hasMeetingAttendees = $false
            if ($task.attendees) {
                if ($task.attendees.required) {
                    foreach ($email in $task.attendees.required) {
                        $recip = $appt.Recipients.Add($email)
                        $recip.Type = 1  # olRequired
                        $hasMeetingAttendees = $true
                    }
                }
                if ($task.attendees.optional) {
                    foreach ($email in $task.attendees.optional) {
                        $recip = $appt.Recipients.Add($email)
                        $recip.Type = 2  # olOptional
                        $hasMeetingAttendees = $true
                    }
                }
                $appt.Recipients.ResolveAll() | Out-Null
            }

            if ($hasMeetingAttendees -or $task.isMeeting) {
                $appt.MeetingStatus = 1  # olMeeting
            }

            if ($task.send -eq $true) {
                $appt.Send()
                $result.detail = "Meeting created and invites sent: $($task.subject)"
            } else {
                $appt.Save()
                $result.detail = "Event created: $($task.subject) (EntryID: $($appt.EntryID))"
                $result.entryId = $appt.EntryID
            }
            $result.success = $true
        }

        # ── Calendar: Respond to meeting ─────────────────────────
        "calendar_respond" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            $responseBody = if ($task.responseBody) { $task.responseBody } else { "" }

            switch ($task.response) {
                "accept"    { $resp = $item.Respond(3, $true); if ($responseBody) { $resp.Body = $responseBody }; $resp.Send() }  # olMeetingAccepted
                "tentative" { $resp = $item.Respond(2, $true); if ($responseBody) { $resp.Body = $responseBody }; $resp.Send() }  # olMeetingTentative
                "decline"   { $resp = $item.Respond(4, $true); if ($responseBody) { $resp.Body = $responseBody }; $resp.Send() }  # olMeetingDeclined
            }
            $result.success = $true
            $result.detail = "Responded: $($task.response)"
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        # ── Calendar: Cancel meeting ─────────────────────────────
        "calendar_cancel" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            $item.MeetingStatus = 5  # olMeetingCanceled
            if ($task.cancellationBody) { $item.Body = $task.cancellationBody }
            $item.Send()
            $result.success = $true
            $result.detail = "Meeting canceled"
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        # ── Calendar: Update event ───────────────────────────────
        "calendar_update" {
            $item = $namespace.GetItemFromID($task.originalEntryId)
            if ($task.updates.start) { $item.Start = [DateTime]::Parse($task.updates.start) }
            if ($task.updates.end) { $item.End = [DateTime]::Parse($task.updates.end) }
            if ($task.updates.subject) { $item.Subject = $task.updates.subject }
            if ($task.updates.location) { $item.Location = $task.updates.location }
            if ($task.updates.body) { $item.Body = $task.updates.body }
            $item.Save()

            if ($task.send -eq $true -and $item.MeetingStatus -eq 1) {
                $item.Send()
                $result.detail = "Event updated and update sent"
            } else {
                $result.detail = "Event updated (no invites sent)"
            }
            $result.success = $true
            [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null
        }

        default {
            $result.detail = "Unknown action: $($task.action)"
        }
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    $result | ConvertTo-Json -Depth 5 -Compress
} catch {
    @{
        success = $false
        action  = if ($task) { $task.action } else { "unknown" }
        error   = $_.Exception.Message
        detail  = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5 -Compress
}
