package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.infrastructure.database.monitoring.DatabaseMetrics
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.observation.ObservationRegistry
import org.jooq.ExecuteListenerProvider
import org.jooq.impl.DefaultExecuteListenerProvider
import org.springframework.beans.factory.ObjectProvider
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.transaction.TransactionExecutionListener

@Configuration(proxyBeanMethods = false)
class DatabaseObservationConfiguration {
    @Bean
    fun databaseMetrics(registry: MeterRegistry) = DatabaseMetrics(registry)

    @Bean
    fun entryPointResolver(observations: ObjectProvider<ObservationRegistry>) =
        EntryPointResolver(observations.getIfAvailable { ObservationRegistry.NOOP })

    @Bean
    fun databaseQueryListenerProvider(
        metrics: DatabaseMetrics,
        entryPoints: EntryPointResolver,
        @Value($$"${spring.application.name}") application: String,
    ): ExecuteListenerProvider = DefaultExecuteListenerProvider(DatabaseQueryListener(metrics, entryPoints, SqlComment(application)))

    @Bean
    fun databaseTransactionListener(metrics: DatabaseMetrics, entryPoints: EntryPointResolver): TransactionExecutionListener =
        DatabaseTransactionListener(metrics, entryPoints)
}
