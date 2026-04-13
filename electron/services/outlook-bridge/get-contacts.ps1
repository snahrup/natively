# get-contacts.ps1 — Read contacts from Outlook
param(
    [string]$Query = "",
    [int]$MaxItems = 50
)

$ErrorActionPreference = 'Stop'

try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject("Outlook.Application")
    $namespace = $outlook.GetNamespace("MAPI")
    $contactsFolder = $namespace.GetDefaultFolder(10)  # olFolderContacts
    $items = $contactsFolder.Items

    if ($Query) {
        $filter = "[FullName] ci_startswith '$Query' OR [CompanyName] ci_startswith '$Query' OR [Email1Address] ci_startswith '$Query'"
        $items = $items.Restrict($filter)
    }

    $contacts = @()
    $count = 0

    foreach ($item in $items) {
        if ($count -ge $MaxItems) { break }
        if ($item.Class -ne 40) { continue }  # olContact

        $contacts += @{
            entryId    = $item.EntryID
            fullName   = $item.FullName
            firstName  = $item.FirstName
            lastName   = $item.LastName
            company    = $item.CompanyName
            jobTitle   = $item.JobTitle
            email      = $item.Email1Address
            email2     = $item.Email2Address
            phone      = $item.BusinessTelephoneNumber
            mobile     = $item.MobileTelephoneNumber
            categories = if ($item.Categories) { $item.Categories -split ',\s*' } else { @() }
        }
        $count++
        try { [Runtime.InteropServices.Marshal]::ReleaseComObject($item) | Out-Null } catch { }
    }

    [Runtime.InteropServices.Marshal]::ReleaseComObject($items) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($contactsFolder) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($namespace) | Out-Null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($outlook) | Out-Null

    @{ contacts = $contacts } | ConvertTo-Json -Depth 5 -Compress
} catch {
    @{ error = $_.Exception.Message; contacts = @() } | ConvertTo-Json -Depth 5 -Compress
}
