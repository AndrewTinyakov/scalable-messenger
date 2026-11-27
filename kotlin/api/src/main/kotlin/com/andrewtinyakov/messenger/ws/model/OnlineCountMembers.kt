package com.andrewtinyakov.messenger.ws.model

import com.andrewtinyakov.messenger.auth.model.UserId

data class OnlineCountMembers(
    val memberCount: Int,
    val memberIds: List<UserId>,
) {
    companion object {
        const val MAX_MEMBERS = 200
    }
}
