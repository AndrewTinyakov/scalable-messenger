package com.andrewtinyakov.messenger.infrastructure.database

import com.andrewtinyakov.messenger.infrastructure.database.scheduling.ReplicaLagScheduler
import com.zaxxer.hikari.HikariDataSource
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.jdbc.autoconfigure.DataSourceProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Primary

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "messenger.database.replica", name = ["url"])
class ReplicaRoutingConfiguration {
    @Bean
    @ConfigurationProperties("spring.datasource.hikari")
    fun primaryPool(properties: DataSourceProperties): HikariDataSource =
        properties.initializeDataSourceBuilder().type(HikariDataSource::class.java).build()

    @Bean
    @ConfigurationProperties("messenger.database.replica.hikari")
    fun replicaPool(properties: DataSourceProperties, replica: ReplicaProperties): HikariDataSource =
        properties.initializeDataSourceBuilder().type(HikariDataSource::class.java).url(requireNotNull(replica.url)).build().apply {
            poolName = "replica"
            isReadOnly = true
        }

    @Bean
    @Primary
    fun dataSource(
        @Qualifier("primaryPool") primary: HikariDataSource,
        @Qualifier("replicaPool") replica: HikariDataSource,
    ) = ReplicaRoutingDataSource(primary, replica)

    @Bean
    fun replicaLagMonitor(
        @Qualifier("primaryPool") primary: HikariDataSource,
        @Qualifier("replicaPool") replica: HikariDataSource,
        properties: ReplicaProperties,
    ) = ReplicaLagMonitor(primary, replica, properties)

    @Bean
    fun replicaLagScheduler(lag: ReplicaLagMonitor) = ReplicaLagScheduler(lag)

    @Bean
    fun replicaRoute(routing: ReplicaRoutingDataSource, lag: ReplicaLagMonitor): ReplicaRoute = object : ReplicaRoute {
        override fun available(): Boolean = lag.healthy

        override fun <T> on(block: () -> T): T = routing.onReplica(block)
    }
}
