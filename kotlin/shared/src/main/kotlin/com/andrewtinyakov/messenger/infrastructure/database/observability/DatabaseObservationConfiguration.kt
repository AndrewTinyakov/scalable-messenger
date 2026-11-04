package com.andrewtinyakov.messenger.infrastructure.database.observability

import io.micrometer.core.instrument.MeterRegistry
import org.jooq.ExecuteListenerProvider
import org.jooq.impl.DefaultExecuteListenerProvider
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.transaction.TransactionExecutionListener

@Configuration(proxyBeanMethods = false)
class DatabaseObservationConfiguration {
    @Bean
    fun databaseMetrics(registry: MeterRegistry) = DatabaseMetrics(registry)

    @Bean
    fun databaseQueryListenerProvider(metrics: DatabaseMetrics): ExecuteListenerProvider =
        DefaultExecuteListenerProvider(DatabaseQueryListener(metrics))

    @Bean
    fun databaseTransactionListener(metrics: DatabaseMetrics): TransactionExecutionListener = DatabaseTransactionListener(metrics)
}
