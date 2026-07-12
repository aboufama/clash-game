import type { TransactionOptions } from '../model'
import type { Persistence, UnitOfWork } from '../repositories'
import type { SqlDatabase } from './database'
import { PostgresUnitOfWork } from './repositories'

export class PostgresPersistence implements Persistence {
  private readonly database: SqlDatabase

  constructor(database: SqlDatabase) {
    this.database = database
  }

  transaction<T>(work: (tx: UnitOfWork) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return this.database.withTransaction(sql => work(new PostgresUnitOfWork(sql)), options)
  }

  close(): Promise<void> {
    return this.database.close()
  }
}
