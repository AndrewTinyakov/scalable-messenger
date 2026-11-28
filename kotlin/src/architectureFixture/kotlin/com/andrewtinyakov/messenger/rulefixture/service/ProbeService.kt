package com.andrewtinyakov.messenger.rulefixture.service

class ProbeService {
    class OrdinaryNested

    @org.springframework.transaction.annotation.Transactional
    fun transaction() = Unit

    @org.springframework.scheduling.annotation.Scheduled(fixedDelay = 1000)
    fun tick() = Unit

    fun query() = org.jooq.impl.DSL.selectOne()
}
