package com.andrewtinyakov.messenger.rulefixture.scheduling

class GoodScheduler {
    @org.springframework.scheduling.annotation.Scheduled(fixedDelay = 1000)
    fun tick() = Unit
}
