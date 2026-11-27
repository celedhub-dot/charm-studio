"""Employee capabilities. Unlisted API operations are owner-only."""
USERNAME = "emp101@gmail.com"
PERMISSIONS = {
    "customers": "View and filter Customer Data",
    "chats": "Read chats and attachments",
    "text": "Send text replies",
    "orders": "View orders",
    "media": "Send photos and documents",
    "templates": "Send approved templates",
    "create": "Create and import orders",
    "edit": "Edit orders",
    "extract": "Run WhatsApp extraction",
    "labels": "Standard label matching and PDFs",
    "ai_labels": "Use paid AI label analysis",
    "exports": "Export orders and chats",
    "dashboard": "View dashboard",
    "team": "Post messages and files in team group chats",
}

# All permissions in a tuple are required. Sending returns a chat transcript.
ENDPOINTS = {
    "customer_data": ("customers",), "inbox_conversations": ("chats",),
    "inbox_unread": ("chats",), "inbox_thread": ("chats",), "inbox_media": ("chats",),
    "inbox_send": ("chats", "text"), "inbox_bot_pause": ("chats", "text"), "inbox_send_media": ("chats", "media"),
    "inbox_templates": ("templates",), "inbox_send_template": ("chats", "templates"),
    "list_orders": ("orders",), "create_order": ("create",), "bulk_orders": ("create",),
    "update_order": ("edit",), "export_orders_csv": ("exports", "orders"),
    "orders_sheet": ("exports", "orders"), "inbox_export_chat": ("exports", "chats"),
    "stats": ("dashboard",), "extract": ("extract",), "extract_bulk_file": ("extract",),
    "pdf_analyze": ("labels",), "pdf_annotate": ("labels",), "pdf_preview": ("labels",),
    "list_wa_numbers": ("chats",), "team_post": ("chats", "team"), "team_file": ("chats", "team"), "get_settings": (), "extract_options": (),
}
