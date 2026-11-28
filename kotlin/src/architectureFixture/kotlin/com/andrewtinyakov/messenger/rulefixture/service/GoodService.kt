package com.andrewtinyakov.messenger.rulefixture.service

import org.springframework.transaction.support.TransactionTemplate

@org.springframework.stereotype.Component
class GoodService {
    fun renderExample() = "org.jooq.impl.DSL.selectOne()"

    fun keepException(ex: org.jooq.exception.DataAccessException) = ex

    fun runTransaction(tx: TransactionTemplate) = tx.execute { Unit }
}
