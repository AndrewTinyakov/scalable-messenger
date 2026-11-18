package com.andrewtinyakov.messenger.infrastructure.database

enum class DatabaseTransaction(
    val metricValue: String,
) {
    AUTH_REGISTER("auth.register"),
    AUTH_LOGOUT("auth.logout"),
    CHAT_CREATE_GROUP("chat.create_group"),
    CHAT_ADD_MEMBERS("chat.add_members"),
    CHAT_REMOVE_MEMBER("chat.remove_member"),
    SEND_SINGLE("send.single"),
    SEND_BATCH("send.batch"),
    SEND_REJECT_EXHAUSTED("send.reject_exhausted"),
    OUTBOX_CLAIM("outbox.claim"),
    OUTBOX_COMPLETE("outbox.complete"),
    MESSAGE_MUTATE("message.mutate"),
    MESSAGE_CHANGE_RETENTION("message.change_retention"),
    CHAT_DELETE("chat.delete"),
    MESSAGE_HISTORY("message.history"),
    READ_ADVANCE("read.advance"),
    READ_CLEANUP("read.cleanup"),
    DELETION_ACCEPT("deletion.accept"),
    DELETION_PURGE("deletion.purge"),
    DELETION_VISIBILITY_CLEANUP("deletion.visibility_cleanup"),
    CHAT_PREFERENCES("chat.preferences"),
    MESSAGE_PIN("message.pin"),
    OTHER("other"),
}
