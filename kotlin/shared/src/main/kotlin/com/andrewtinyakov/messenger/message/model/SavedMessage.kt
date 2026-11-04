package com.andrewtinyakov.messenger.message.model

data class SavedMessage(
    val message: Message,
    val result: SendResult,
)
