package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.auth.model.UserId

fun orderedDirectPair(first: UserId, second: UserId): Pair<UserId, UserId> =
    if (first.value <= second.value) first to second else second to first

fun directPairKey(first: UserId, second: UserId): String =
    orderedDirectPair(first, second).let { (lower, higher) -> "${lower.value}:${higher.value}" }
