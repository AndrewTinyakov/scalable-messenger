package com.andrewtinyakov.messenger.rulefixture.model

sealed interface GoodModel {
    data object Present : GoodModel
}
