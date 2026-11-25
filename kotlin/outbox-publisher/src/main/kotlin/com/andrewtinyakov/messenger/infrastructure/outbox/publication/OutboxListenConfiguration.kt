package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublisherProperties
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.sql.DriverManager
import javax.sql.DataSource

@Configuration(proxyBeanMethods = false)
class OutboxListenConfiguration {
    @Bean
    fun outboxListenConnections(
        dataSource: DataSource,
        properties: OutboxPublisherProperties,
        @Value("\${spring.datasource.username:}") username: String,
        @Value("\${spring.datasource.password:}") password: String,
    ): OutboxListenConnections {
        val url = properties.listenUrl ?: return OutboxListenConnections { dataSource.connection }
        return OutboxListenConnections { DriverManager.getConnection(url, username, password) }
    }
}
